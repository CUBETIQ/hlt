import * as fs from "fs";
import * as http from "http";
import { HttpsProxyAgent } from "https-proxy-agent";
import * as os from "os";
import * as path from "path";
import { Socket, io } from "socket.io-client";
import { TunnelRequest, TunnelResponse } from "./lib";
import { addPrefixOnHttpSchema, generateUUID } from "./util";

import { PROFILE_DEFAULT, PROFILE_PATH, SERVER_DEFAULT_URL } from "./constant";
import { ClientOptions, Options, TunnelConfig, TunnelGrant } from "./interface";
import { getToken, getTunnelConfig } from './sdk';
import { TunnelStats, TunnelStatsSnapshot, formatBytes } from "./stats";

/**
 * One pooled keep-alive agent for every forwarded local request. Without it each
 * tunnelled request opens a fresh TCP connection to the local app — a handshake
 * plus a "localhost" DNS lookup that on a dual-stack machine can cost hundreds of
 * milliseconds on the first hit, which is exactly the "first visit is slow" feel.
 */
const localAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: Infinity,
    maxFreeSockets: 256,
    scheduling: "lifo",
});

export interface Client {
    getEndpoint(): string | null;
    getEndpoints(): string[];
    getStats(): TunnelStatsSnapshot;
    stop(): void;
}

/** Mirror of the server's hostname layout: <name>.domain or <name>-domain. */
function buildTunnelUrl(config: TunnelConfig, name: string): string {
    const sep = config.format === "prefix" ? "-" : ".";
    return `${config.scheme}://${name}${sep}${config.domain}`;
}

function colorStatus(status: number): string {
    const code = String(status);
    if (status >= 500) return `\x1b[31m${code}\x1b[0m`; // Red
    if (status >= 400) return `\x1b[33m${code}\x1b[0m`; // Yellow
    if (status >= 300) return `\x1b[36m${code}\x1b[0m`; // Cyan
    if (status >= 200) return `\x1b[32m${code}\x1b[0m`; // Green
    return `\x1b[37m${code}\x1b[0m`;
}

export class HttpTunnelClient implements Client {
    // create socket instance
    private socket: Socket | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private keepAliveTimeout: number | null = null;
    private endpoint: string | null = null;
    private endpoints: string[] = [];
    private tunnelConfig: TunnelConfig | null = null;
    private stats = new TunnelStats();

    private keepAlive() {
        if (!this.socket) {
            return;
        }

        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
        }

        this.keepAliveTimer = setInterval(() => {
            if (this.socket && this.socket.connected) {
                this.socket.send("ping");
            }
        }, this.keepAliveTimeout || 5000);
        this.keepAliveTimer.unref?.();
    }

    // Init the Client for config file
    public initConfigFile = async (options: any) => {
        const profile = options.profile || PROFILE_DEFAULT;
        const configDir = path.resolve(os.homedir(), PROFILE_PATH);

        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir);
            console.log(`config file ${configDir} was created`);
        }

        let config: any = {};
        const configFilename = `${profile}.json`;
        const configFilePath = path.resolve(configDir, configFilename);

        if (fs.existsSync(configFilePath)) {
            config = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
        }

        // Force reset config server from client init
        if (!config.server || options.force) {
            config.server = options.server || SERVER_DEFAULT_URL;
        }

        if (!config.token && options.token) {
            config.token = options.token;
        }

        if (!config.clientId) {
            config.clientId = options.client || generateUUID();
        }

        if (!config.apiKey && options.key) {
            config.apiKey = options.key;
        }

        let errorCode = 0;
        if (!config.token || options.force) {
            console.log(`Generating token from server: ${config.server}`);
            await getToken(config.server, {
                timestamp: (new Date().getTime()),
                clientId: config.clientId,
                apiKey: config.apiKey,
            })
                .then((resp: any) => {
                    if (resp.data?.token) {
                        console.log("Token generated successfully!");
                        config.token = resp.data?.token;
                    } else {
                        errorCode = 1;
                        console.error("Generate token failed, return with null or empty from server!", resp);
                        return;
                    }
                })
                .catch((err: any) => {
                    errorCode = 1;
                    console.error("cannot get token from server", err);
                    return;
                });
        }

        if (errorCode === 0) {
            fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2));
            console.log(`initialized config saved successfully to: ${configFilePath}`);
        }
    };

    // Start Client
    public initStartClient = async (options: Options) => {
        const profile = options.profile || PROFILE_DEFAULT;
        const clientId = `${options.apiKey || options.clientId || generateUUID()}`;
        const server = options.server || SERVER_DEFAULT_URL;

        // The public name defaults to the client id, so a client always keeps
        // its own reserved subdomain unless it asks for something else.
        const baseName =
            profile === PROFILE_DEFAULT ? clientId : `${clientId}-${profile}`;
        const defaultName = options.suffix ? `${baseName}-${options.suffix}` : baseName;
        const requestedNames = (options.names && options.names.length
            ? options.names
            : [defaultName]
        ).map((n) => n.toLowerCase().trim()).filter(Boolean);

        // Ask the server how it addresses tunnels. Older servers answer null and
        // we fall back to the legacy client-side host construction.
        const tunnelConfig = await getTunnelConfig(server);
        this.tunnelConfig = tunnelConfig;

        const clientIdSub =
            profile === PROFILE_DEFAULT ? `${clientId}-` : `${clientId}-${profile}-`;
        const clientEndpoint = (
            options.suffix ? `${clientIdSub}${options.suffix}-` : clientIdSub
        )
            .toLowerCase()
            .trim();

        const serverUrl = tunnelConfig
            ? buildTunnelUrl(tunnelConfig, requestedNames[0])
            : addPrefixOnHttpSchema(server, clientEndpoint);
        this.endpoint = serverUrl;
        this.endpoints = [serverUrl];

        // extra options for socket to identify the client (authentication and options of tunnel)
        const defaultParams = {
            apiKey: options.apiKey,
            clientId: options.clientId,
            profile: profile,
            clientIdSub: clientIdSub,
            clientEndpoint: clientEndpoint,
            serverUrl: serverUrl,
            hostnames: requestedNames,
            keep_connection: options.keep_connection || true,
        };

        // extra info for notify about the running of the tunnel (it's private info, other platfom cannot access this)
        // this using for internal only (don't worry about this)
        const osInfo = {
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            timestamp: new Date().getTime(),
        };

        const initParams: any = {
            path: "/$cubetiq_http_tunnel",
            transports: ["websocket"],
            auth: {
                token: options.token,
                ...defaultParams,
            },
            headers: {
                ...defaultParams,
                os: osInfo,
            },
            // reconnection: true,
        };

        const http_proxy = process.env.https_proxy || process.env.http_proxy;
        if (http_proxy) {
            initParams.agent = new HttpsProxyAgent(http_proxy);
        }

        // Connecting to socket server and agent here...
        console.log(`client connecting to server: ${serverUrl}`);
        this.socket = io(serverUrl, initParams);

        const clientLogPrefix = `client: ${clientId} on profile: ${profile}`;
        const targetHost = options.host || "localhost";
        const localHost = `${targetHost}:${options.port}`;

        // Host header policy. Preserving the public host is the right default —
        // frameworks build absolute redirect/cookie URLs from it — but dev servers
        // (Next.js `/_next/*`, Vite) reject requests whose Host/Origin is not their
        // own with a 403. `--host-header rewrite` (or an explicit value) makes the
        // local app see a same-origin localhost request instead.
        const hostHeaderOpt = options.hostHeader || options.origin;
        const rewrittenHost =
            !hostHeaderOpt || hostHeaderOpt === "preserve"
                ? null
                : hostHeaderOpt === "rewrite" || hostHeaderOpt === "local" || hostHeaderOpt === "true"
                    ? localHost
                    : hostHeaderOpt;
        let hintedOn403 = false;

        this.socket.on("connect", () => {
            if (this.socket!.connected) {
                console.log(`\x1b[32m✔ ${clientLogPrefix} is connected to server successfully!\x1b[0m`);
            }
        });

        // The server is the authority on which public URLs this client holds;
        // it may grant more than one.
        this.socket.on("tunnel_grant", (grant: TunnelGrant) => {
            if (grant?.urls?.length) {
                this.endpoints = grant.urls;
                this.endpoint = grant.urls[0];
            }
            this.endpoints.forEach((url) => {
                console.log(`\x1b[36m➜ Forwarding:\x1b[0m ${url} -> http://${localHost}`);
            });
            // Live status line last, so it stays pinned below the banner.
            this.stats.start();
        });

        this.socket.on("connect_error", (e) => {
            console.error(
                `${clientLogPrefix} connect error:`,
                (e && e.message) || "something wrong"
            );
            if ((options as any).exitOnError !== false && e && e.message && e.message.startsWith("[40")) {
                process.exit(1);
            }
        });

        this.socket.on("disconnect", (reason) => {
            this.stats.stop();
            console.warn(`${clientLogPrefix} disconnected: ${reason}!`);
            if (reason === "io server disconnect") {
                if (this.keepAliveTimer) {
                    clearInterval(this.keepAliveTimer);
                    this.keepAliveTimer = null;
                }
                this.socket?.disconnect();
                if ((options as any).exitOnError !== false) {
                    process.exit(0);
                }
            }
        });

        this.socket.on("disconnect_exit", (reason) => {
            this.stats.stop();
            console.warn(`\x1b[33m${clientLogPrefix} disconnected and terminated: ${reason}!\x1b[0m`);
            if (this.keepAliveTimer) {
                clearInterval(this.keepAliveTimer);
                this.keepAliveTimer = null;
            }
            this.socket?.disconnect();
            if ((options as any).exitOnError !== false) {
                process.exit(0);
            }
        });

        this.socket.on("request", (requestId, request) => {
            const upgradeHeader = (request.headers?.upgrade || "").toLowerCase();
            const isWebSocket = upgradeHeader === "websocket";
            const startTime = Date.now();

            const rawIp = request.headers?.["x-forwarded-for"] || request.headers?.["x-real-ip"] || "127.0.0.1";
            const clientIp = typeof rawIp === "string" ? rawIp.split(",")[0].trim() : "127.0.0.1";

            request.port = options.port;
            request.hostname = options.host || "localhost";

            if (rewrittenHost) {
                request.headers.host = rewrittenHost;
                // Origin/Referer are what dev-server cross-origin checks actually
                // read; leaving the public host there re-triggers the 403.
                if (request.headers.origin) {
                    request.headers.origin = `http://${rewrittenHost}`;
                }
                if (request.headers.referer) {
                    request.headers.referer = String(request.headers.referer).replace(
                        /^https?:\/\/[^/]+/,
                        `http://${rewrittenHost}`
                    );
                }
            }

            // Ensure headers for Upgrade are formatted cleanly
            if (isWebSocket) {
                request.headers.connection = request.headers.connection || "Upgrade";
                request.headers.upgrade = "websocket";
                // An upgraded socket is hijacked and must not return to the pool.
                request.agent = false;
            } else {
                // `connection` is hop-by-hop: forwarding the browser's value (often
                // `close`) would defeat the pool. Let the agent decide instead.
                delete request.headers.connection;
                request.agent = localAgent;
            }

            const tunnelRequest = new TunnelRequest(this.socket!, requestId);
            let reqBytes = 0;
            tunnelRequest.on("data", (chunk: any) => {
                if (chunk && chunk.length) {
                    reqBytes += chunk.length;
                }
            });

            let localReq: http.ClientRequest;
            try {
                localReq = http.request(request);
            } catch (err: any) {
                const duration = Date.now() - startTime;
                this.stats.recordHttp(0, 0, true);
                this.stats.error(
                    `${colorStatus(502)} Bad Gateway \x1b[1m${isWebSocket ? "WS" : request.method}\x1b[0m ${request.path} ` +
                    `from \x1b[36m${clientIp}\x1b[0m [\x1b[31m${err?.message || String(err)}\x1b[0m] \x1b[90m(${duration}ms)\x1b[0m`
                );
                this.socket?.emit("request-error", requestId, err?.message || String(err));
                tunnelRequest.destroy(err);
                return;
            }

            localReq.once("socket", (s: any) => s.setNoDelay?.(true));
            tunnelRequest.pipe(localReq);

            const onTunnelRequestError = (e: any) => {
                const duration = Date.now() - startTime;
                this.stats.error(
                    `${colorStatus(502)} Tunnel Request Error \x1b[1m${isWebSocket ? "WS" : request.method}\x1b[0m ${request.path} ` +
                    `from \x1b[36m${clientIp}\x1b[0m [\x1b[31m${e?.message || String(e)}\x1b[0m] \x1b[90m(${duration}ms)\x1b[0m`
                );
                localReq.destroy(e);
            };

            tunnelRequest.once("error", onTunnelRequestError);

            const onLocalResponse = (localRes: any) => {
                localReq.off("error", onLocalError);

                if (isWebSocket && localRes.upgrade) {
                    return;
                }

                let resBytes = 0;
                localRes.on("data", (chunk: any) => {
                    if (chunk && chunk.length) {
                        resBytes += chunk.length;
                    }
                });

                const tunnelResponse = new TunnelResponse(this.socket!, requestId);

                tunnelResponse.writeHead(
                    localRes.statusCode,
                    localRes.statusMessage,
                    localRes.headers,
                    localRes.httpVersion
                );

                localRes.pipe(tunnelResponse);

                localRes.once("end", () => {
                    const duration = Date.now() - startTime;
                    const status = localRes.statusCode || 200;
                    const statusStr = colorStatus(status);
                    const statusMsg = localRes.statusMessage || "";
                    const reqLen = formatBytes(reqBytes || parseInt(request.headers?.["content-length"] || "0", 10));
                    const resLen = formatBytes(resBytes || parseInt(localRes.headers?.["content-length"] || "0", 10));

                    this.stats.recordHttp(reqBytes, resBytes, status >= 500);
                    this.stats.log(
                        `${statusStr} ${statusMsg ? statusMsg + " " : ""}\x1b[1m${request.method}\x1b[0m ${request.path} ` +
                        `from \x1b[36m${clientIp}\x1b[0m ` +
                        `[\x1b[90min:\x1b[0m ${reqLen} | \x1b[90mout:\x1b[0m ${resLen}] ` +
                        `\x1b[90m(${duration}ms)\x1b[0m`
                    );

                    // A dev server answering 403 to its own asset routes is almost
                    // always the cross-origin guard (Next.js `/_next/*`, Vite).
                    if (status === 403 && !rewrittenHost && !hintedOn403) {
                        hintedOn403 = true;
                        this.stats.log(
                            `\x1b[33m! 403 from ${localHost}. Dev servers block requests whose Host/Origin is not their own ` +
                            `(e.g. Next.js on /_next/*). Restart with \x1b[1m--host-header rewrite\x1b[0m\x1b[33m, ` +
                            `or allow this tunnel host in the framework config (Next.js: allowedDevOrigins).\x1b[0m`
                        );
                    }
                });

                localRes.on("error", (err: any) => {
                    tunnelResponse.destroy(err);
                });
            };

            const onLocalError = (error: any) => {
                const duration = Date.now() - startTime;
                this.stats.recordHttp(reqBytes, 0, true);
                this.stats.error(
                    `${colorStatus(502)} Bad Gateway \x1b[1m${isWebSocket ? "WS" : request.method}\x1b[0m ${request.path} ` +
                    `from \x1b[36m${clientIp}\x1b[0m [\x1b[31m${error?.message || error}\x1b[0m] \x1b[90m(${duration}ms)\x1b[0m`
                );
                localReq.off("response", onLocalResponse);
                this.socket?.emit("request-error", requestId, error && error.message);
                tunnelRequest.destroy(error);
            };

            const onUpgrade = (localRes: any, localSocket: any, localHead: any) => {
                localReq.off("error", onLocalError);
                if (localHead && localHead.length) localSocket.unshift(localHead);

                const tunnelResponse = new TunnelResponse(this.socket!, requestId, true);
                tunnelResponse.writeHead(null, null, localRes.headers, localRes.httpVersion || "1.1");

                let wsInBytes = 0;
                let wsOutBytes = 0;
                localSocket.on("data", (chunk: any) => { wsOutBytes += chunk?.length || 0; });
                tunnelResponse.on("data", (chunk: any) => { wsInBytes += chunk?.length || 0; });

                this.stats.recordWsOpen();
                this.stats.log(
                    `\x1b[32m101\x1b[0m Switching Protocols \x1b[1mWS\x1b[0m ${request.path} ` +
                    `from \x1b[36m${clientIp}\x1b[0m \x1b[90m(upgraded)\x1b[0m`
                );

                localSocket.pipe(tunnelResponse).pipe(localSocket);

                const cleanup = (err?: any) => {
                    localSocket.destroy(err);
                    tunnelResponse.destroy(err);
                    tunnelRequest.destroy(err);
                };

                localSocket.once("error", (err: any) => {
                    cleanup(err);
                });
                localSocket.once("close", () => {
                    const duration = Date.now() - startTime;
                    this.stats.recordWsClose(wsInBytes, wsOutBytes);
                    this.stats.log(
                        `\x1b[90mWS ${request.path} closed from ${clientIp} ` +
                        `[in: ${formatBytes(wsInBytes)} | out: ${formatBytes(wsOutBytes)}] (${duration}ms)\x1b[0m`
                    );
                    cleanup();
                });
                tunnelResponse.once("error", (err: any) => {
                    cleanup(err);
                });
                tunnelResponse.once("close", () => {
                    cleanup();
                });
            };

            localReq.once("error", onLocalError);
            localReq.once("response", onLocalResponse);

            if (isWebSocket) {
                localReq.once("upgrade", onUpgrade);
            }
        });

        // reconnect manually
        // const tryReconnect = () => {
        //     setTimeout(() => {
        //         socket!.io.open((err) => {
        //             if (err) {
        //                 tryReconnect();
        //             }
        //         });
        //     }, 2000);
        // };
        // socket.io.on("close", tryReconnect);

        // Ctrl-C on the CLI: clear the live line and leave a session summary.
        if ((options as any).exitOnError !== false) {
            const onExitSignal = () => {
                this.stats.stop();
                console.log(`\n${this.stats.summary()}`);
                process.exit(0);
            };
            process.once("SIGINT", onExitSignal);
            process.once("SIGTERM", onExitSignal);
        }

        this.keepAlive();
    };

    public start = async (clientOptions: Partial<ClientOptions>): Promise<Client | undefined> => {
        const { port, address, options = {} } = clientOptions;

        // Load host and port check
        if (!port) {
            if (!address) {
                console.error("port or address is required!");
                return;
            }

            const [host, portStr] = address.split(":");
            if (!host || !portStr) {
                console.error("invalid address!");
                return;
            }

            options.host = host;
            try {
                options.port = parseInt(portStr);
            } catch (e) {
                console.error("invalid port!");
                return;
            }
        } else {
            if (typeof address !== "number" && address && address.includes(":")) {
                const [host, portStr] = address.split(":");
                if (host) {
                    options.host = host;
                }

                if (portStr) {
                    try {
                        options.port = parseInt(portStr);
                        console.log(`default port: ${port} will be ignored and override by port: ${options.port}`);
                    } catch (e) {
                        options.port = port;
                    }
                }
            } else {
                options.port = port;
                console.log(`default port: ${port} will be forwared`);
            }
        }

        const configDir = path.resolve(os.homedir(), PROFILE_PATH);

        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir);
        }

        let config: any = {};
        const configFilename = `${options.profile || PROFILE_DEFAULT}.json`;
        const configFilePath = path.resolve(configDir, configFilename);

        if (fs.existsSync(configFilePath)) {
            config = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
        } else {
            if (options.autoinit) {
                await this.initConfigFile(options);
                config = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
            } else {
                console.warn(`profile: ${options.profile || PROFILE_DEFAULT} not found!`);
                return;
            }
        }

        if (!config.server) {
            config.server = SERVER_DEFAULT_URL;
        }

        if (!config.token) {
            console.info(`please init or set token for ${config.server}`);
            return;
        }

        if (!config.clientId) {
            if (!config.apiKey) {
                console.info(`please init or create a client for ${config.server}`);
            } else {
                config.clientId = config.apiKey;
            }
            return;
        }

        // options.port = port;
        options.token = config.token;
        options.server = config.server;
        options.clientId = config.clientId;
        options.apiKey = options.key || config.apiKey;

        if (options.suffix === "port" || options.suffix === "true") {
            options.suffix = `${port}`;
        } else if (options.suffix === "false") {
            options.suffix = undefined;
        } else if (options.suffix === "gen" || options.suffix === "uuid") {
            options.suffix = generateUUID();
        }

        await this.initStartClient(options);
        return this;
    };

    /** Live counters for this tunnel (requests, inbound/outbound bytes). */
    public getStats = () => this.stats.snapshot();

    public stop = () => {
        this.stats.stop();
        if (this.socket) {
            this.socket.disconnect();
            this.socket.close();
            this.socket = null;
            this.keepAliveTimer && clearInterval(this.keepAliveTimer);

            console.log("client stopped from server:", this.endpoint);
        }
    };

    public getEndpoint = () => {
        return this.endpoint;
    }

    /** All public URLs granted by the server for this tunnel. */
    public getEndpoints = () => {
        return this.endpoints;
    }
}

export const client = new HttpTunnelClient();

export const initConfigFileClient = client.initConfigFile;
export const startClient = client.start;
export const stopClient = client.stop;
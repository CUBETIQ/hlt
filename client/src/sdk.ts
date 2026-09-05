import axios, { AxiosResponse } from "axios";
import { HttpTunnelClient } from "./api";
import { SERVER_DEFAULT_URL } from "./constant";
import { Options } from "./interface";
import { generateUUID } from "./util";

export interface TokenPayload {
  clientId?: string;
  apiKey?: string;
  timestamp?: number;
}

export interface TokenResponse {
  token: string;
  clientId: string;
  expiresIn: string;
  timestamp: number;
}

/**
 * Request a JWT tunnel token from the HLT server.
 * Connects to the unified /api/token endpoint.
 */
export async function getToken(
  baseUrl: string = SERVER_DEFAULT_URL,
  data: TokenPayload = {}
): Promise<AxiosResponse<TokenResponse>> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/token`;
  return axios({
    method: "POST",
    url: url,
    data: {
      clientId: data.clientId,
      apiKey: data.apiKey,
      timestamp: data.timestamp || Date.now(),
    },
    headers: {
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
    },
  });
}

// Backward compatibility alias
export const getTokenFree = getToken;

export interface HltClientConfig {
  server?: string;
  apiKey?: string;
  token?: string;
  profile?: string;
  clientId?: string;
}

export interface ConnectOptions {
  port: number;
  host?: string;
  address?: string;
  suffix?: string;
  origin?: string;
  keep_connection?: boolean;
}

export interface TunnelInstance {
  endpoint: string | null;
  stop(): void;
  client: HttpTunnelClient;
}

/**
 * HltClient: High-level SDK for Node.js and Bun JavaScript runtimes.
 * Supports programmatic tunnel creation, automatic token negotiation, and lifecycle management.
 */
export class HltClient {
  private config: HltClientConfig;
  private activeClients: HttpTunnelClient[] = [];

  constructor(config: HltClientConfig = {}) {
    this.config = {
      server: config.server || SERVER_DEFAULT_URL,
      profile: config.profile || "sdk",
      clientId: config.clientId || generateUUID(),
      apiKey: config.apiKey,
      token: config.token,
    };
  }

  /**
   * Acquire a valid JWT token from the server if not already provided.
   */
  public async ensureToken(): Promise<string> {
    if (this.config.token) {
      return this.config.token;
    }
    const resp = await getToken(this.config.server, {
      clientId: this.config.clientId,
      apiKey: this.config.apiKey,
    });
    if (!resp.data?.token) {
      throw new Error(
        "Failed to acquire token from HLT server: " + JSON.stringify(resp.data)
      );
    }
    this.config.token = resp.data.token;
    return this.config.token;
  }

  /**
   * Start a tunnel forwarding to a local port or address.
   */
  public async connect(options: ConnectOptions): Promise<TunnelInstance> {
    const token = await this.ensureToken();
    const tunnelClient = new HttpTunnelClient();

    const opts: Options & { exitOnError?: boolean } = {
      server: this.config.server,
      profile: this.config.profile,
      clientId: this.config.clientId,
      apiKey: this.config.apiKey,
      token: token,
      port: options.port,
      host: options.host || "localhost",
      suffix: options.suffix,
      origin: options.origin,
      keep_connection: options.keep_connection ?? true,
      exitOnError: false,
    };

    await tunnelClient.initStartClient(opts);
    this.activeClients.push(tunnelClient);

    return {
      endpoint: tunnelClient.getEndpoint(),
      stop: () => {
        tunnelClient.stop();
        this.activeClients = this.activeClients.filter((c) => c !== tunnelClient);
      },
      client: tunnelClient,
    };
  }

  /**
   * Close all active tunnels managed by this client.
   */
  public closeAll(): void {
    for (const client of this.activeClients) {
      client.stop();
    }
    this.activeClients = [];
  }
}

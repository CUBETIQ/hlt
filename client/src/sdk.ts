import axios, { AxiosResponse } from "axios";
import { HttpTunnelClient } from "./api";
import { SERVER_DEFAULT_URL } from "./constant";
import { Options, TunnelConfig } from "./interface";
import { TunnelStatsSnapshot } from "./stats";
import { generateUUID } from "./util";

export interface TokenPayload {
  clientId?: string;
  apiKey?: string;
  timestamp?: number;
  /** An existing token for `clientId`, presented when renewing it. */
  currentToken?: string;
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
      // Proof that we already hold this client id, so the server treats the
      // request as a renewal instead of a land-grab on someone else's id.
      ...(data.currentToken ? { Authorization: `Bearer ${data.currentToken}` } : {}),
    },
  });
}

// Backward compatibility alias
export const getTokenFree = getToken;

/**
 * Read the server's public addressing scheme so the client can build the host
 * it should dial. Returns null on older servers that do not expose it.
 */
export async function getTunnelConfig(
  baseUrl: string = SERVER_DEFAULT_URL
): Promise<TunnelConfig | null> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/api/config`;
    const resp = await axios.get(url, { timeout: 5000 });
    const tunnel = resp.data?.tunnel;
    return tunnel && tunnel.enabled ? tunnel : null;
  } catch {
    return null;
  }
}

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
  /** "preserve" (default), "rewrite", or an explicit Host header value. */
  hostHeader?: string;
  keep_connection?: boolean;
  /** Public tunnel names to reserve. Defaults to the client id. */
  names?: string[];
}

export interface TunnelInstance {
  endpoint: string | null;
  endpoints: string[];
  /** Live traffic counters for this tunnel. */
  stats: TunnelStatsSnapshot;
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
    // Adopt the id the server issued: it is the identity tunnel names lock to.
    if (resp.data?.clientId) {
      this.config.clientId = resp.data.clientId;
    }
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
      hostHeader: options.hostHeader,
      names: options.names,
      keep_connection: options.keep_connection ?? true,
      exitOnError: false,
    };

    await tunnelClient.initStartClient(opts);
    this.activeClients.push(tunnelClient);

    return {
      // Getters: the server's grant lands just after connect, so a snapshot
      // taken here would miss the extra URLs.
      get endpoint() {
        return tunnelClient.getEndpoint();
      },
      get endpoints() {
        return tunnelClient.getEndpoints();
      },
      get stats() {
        return tunnelClient.getStats();
      },
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

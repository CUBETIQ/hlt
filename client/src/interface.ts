export interface Options {
    server?: string;
    profile?: string;
    key?: string;
    apiKey?: string;
    suffix?: string;
    clientId?: string;
    keep_connection?: boolean;
    token?: string;
    origin?: string;
    port?: number;
    host?: string;
    autoinit?: boolean; // auto init the profile (if profile not found)
    names?: string[]; // requested public tunnel names (default: the client id)

    // [key: string]: any;
}

/** Public addressing scheme advertised by the server at GET /api/config. */
export interface TunnelConfig {
    enabled: boolean;
    domain: string | null;
    format: "subdomain" | "prefix";
    scheme: string;
    maxPerClient: number;
}

/** What the server grants on connect. */
export interface TunnelGrant {
    clientId: string | null;
    names: string[];
    hosts: string[];
    urls: string[];
}

export interface ClientOptions {
    port: number;
    address?: string; // e.g. localhost:8081 (take if port is not set)
    options?: Options;
}
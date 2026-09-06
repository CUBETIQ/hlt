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
    /**
     * Host header sent to the local app: "preserve" (default, keeps the public
     * tunnel host), "rewrite" (uses <host>:<port>, which is what dev servers
     * such as Next.js require for their /_next/* cross-origin guard), or an
     * explicit host value.
     */
    hostHeader?: string;
    port?: number;
    host?: string;
    autoinit?: boolean; // auto init the profile (if profile not found)
    names?: string[]; // requested public tunnel names (default: the client id)
    /** silent | error | warn | info (default) | debug */
    logLevel?: string;
    /** false hides the live status line; counters keep running. */
    stats?: boolean;

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
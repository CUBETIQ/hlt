export interface Options {
    server?: string;
    profile?: string;
    key?: string;
    apiKey?: string;
    access?: string;
    suffix?: string;
    clientId?: string;
    keep_connection?: boolean;
    token?: string;
    origin?: string;
    port?: number;
    host?: string;
    autoinit?: boolean; // auto init the profile (if profile not found)

    // [key: string]: any;
}

export interface ClientOptions {
    port: number;
    address?: string; // e.g. localhost:8081 (take if port is not set)
    options?: Options;
}
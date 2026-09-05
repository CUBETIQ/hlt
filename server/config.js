const DEV_SECRET = "hlt_default_secret_key_change_me";
const isProduction = process.env.NODE_ENV === "production";

// In production a missing secret is a hard failure; in dev we fall back to a
// well-known value (tunnel tokens are worthless without it anyway).
const requireSecret = (name, devFallback) => {
  const value = process.env[name];
  if (value) return value;
  if (isProduction) {
    throw new Error(
      `[HLT] ${name} must be set when NODE_ENV=production (refusing to start with a default secret)`
    );
  }
  return devFallback;
};

const AppConfig = {
  app: {
    port: parseInt(process.env.PORT, 10) || 3000,
    trusted_host: process.env.TRUSTED_HOST || "localhost:3000",
    request_log: process.env.REQUEST_LOG === "true",
  },
  security: {
    secret_key: requireSecret("SECRET_KEY", DEV_SECRET),
    verify_token: process.env.VERIFY_TOKEN || null,
    // Open registration lets anyone mint a tunnel token: off unless asked for.
    public_token_registration: isProduction
      ? process.env.PUBLIC_TOKEN_REGISTRATION === "true"
      : process.env.PUBLIC_TOKEN_REGISTRATION !== "false",
    server_api_key: process.env.SERVER_API_KEY || null,
  },
  admin: {
    username: process.env.ADMIN_USERNAME || "admin",
    password: requireSecret("ADMIN_PASSWORD", "admin123"),
    // Never share the tunnel-client secret with the admin trust domain, and it
    // must be identical across workers or admin tokens break under clustering.
    jwt_secret: requireSecret("ADMIN_JWT_SECRET", "hlt_admin_jwt_secret"),
    jwt_expires_in: process.env.ADMIN_JWT_EXPIRES_IN || "24h",
  },
  redis: {
    enabled: process.env.REDIS_ENABLED === "true" || process.env.REDIS_ENABLED === true,
    url: process.env.REDIS_URL || "redis://localhost:6379",
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    database: parseInt(process.env.REDIS_DATABASE, 10) || 0,
  },
  socket: {
    // Per-frame cap. Streaming is chunked, so this only needs to cover the
    // largest single chunk; 500MB let one client pin 500MB of heap per frame.
    max_http_buffer_size: parseInt(process.env.MAX_HTTP_BUFFER_SIZE, 10) || 32 * 1024 * 1024,
    concurrency_limit: parseInt(process.env.CONCURRENCY_LIMIT, 10) || 1000,
  },
  cluster: {
    enabled: process.env.CLUSTER_ENABLED === "true" || process.env.NODE_CLUSTER === "true",
    workers: process.env.WORKERS || "1",
  },
};

module.exports = { AppConfig };


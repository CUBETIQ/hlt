const AppConfig = {
  app: {
    port: parseInt(process.env.PORT, 10) || 3000,
    trusted_host: process.env.TRUSTED_HOST || "localhost:3000",
  },
  security: {
    secret_key: process.env.SECRET_KEY || "hlt_default_secret_key_change_me",
    verify_token: process.env.VERIFY_TOKEN || null,
    public_token_registration: process.env.PUBLIC_TOKEN_REGISTRATION !== "false",
    server_api_key: process.env.SERVER_API_KEY || null,
  },
  admin: {
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "admin123",
    jwt_secret: process.env.ADMIN_JWT_SECRET || process.env.SECRET_KEY || "hlt_admin_jwt_secret",
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
    max_http_buffer_size: parseInt(process.env.MAX_HTTP_BUFFER_SIZE, 10) || (1e8 * 5), // 500M
    concurrency_limit: parseInt(process.env.CONCURRENCY_LIMIT, 10) || 1000,
  },
  cluster: {
    enabled: process.env.CLUSTER_ENABLED === "true" || process.env.NODE_CLUSTER === "true",
    workers: process.env.WORKERS || "1",
  },
};

module.exports = { AppConfig };


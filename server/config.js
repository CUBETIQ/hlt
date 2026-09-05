const AppConfig = {
  app: {
    port: process.env.PORT || 3000,
    trusted_host: process.env.TRUSTED_HOST || "localhost:3000",
    trusted_secret: process.env.TRUSTED_SECRET,
  },
  redis: {
    enabled: process.env.REDIS_ENABLED || false,
    url: process.env.REDIS_URL,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    database: process.env.REDIS_DATABASE || 0,
  },
  admin: {
    enabled: process.env.ADMIN_ENABLED || false,
    namespace: process.env.ADMIN_NAMESPACE || "/admin",
    auth_enabled: process.env.ADMIN_AUTH_ENABLED || true,
    auth_type: process.env.ADMIN_AUTH_TYPE || "basic",
    auth_username: process.env.ADMIN_AUTH_USERNAME || "admin",
    auth_password:
      process.env.ADMIN_AUTH_PASSWORD ||
      "$2b$10$uLYLbhGW7OnWW6mRye15puPrwzfvSe/WtDLSz8GdLw6FYHxaNlqb2", // 123456
  },
  security: {
    free_access_type: process.env.FREE_ACCESS_TYPE || "FREE",
    free_secret_key: process.env.FREE_SECRET_KEY,
    free_verify_token: process.env.FREE_VERIFY_TOKEN || process.env.FREE_VERITY_TOKEN,
  },
  socket: {
    max_http_buffer_size: process.env.MAX_HTTP_BUFFER_SIZE || (1e8 * 5), // 5M
    concurrency_limit: process.env.CONCURRENCY_LIMIT || 1000,
  },
  cluster: {
    enabled: process.env.CLUSTER_ENABLED === "true" || process.env.NODE_CLUSTER === "true",
    workers: process.env.WORKERS || "1",
  },
};

module.exports = { AppConfig };

const realWs = require("./ws_patch");
const http = require("http");
const {
  generateUUID: uuidV4,
  parseIntOrDefault,
} = require("./util");
const express = require("express");
const bodyParser = require("body-parser");
const morgan = require("morgan");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

require("dotenv").config();

const { TunnelRequest, TunnelResponse } = require("./lib");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const { AppConfig } = require("./config");
const buildInfo = require("./build_info.js");
const stats = require("./stats");
const logger = require("./logger");

const hostId = `${require("os").hostname()}#${process.pid}`;
const appConfig = AppConfig.app;
const securityConfig = AppConfig.security;
const adminConfig = AppConfig.admin;
const socketConfig = AppConfig.socket;

const app = express();
const httpServer = http.createServer(app);

const webTunnelPath = "/$cubetiq_http_tunnel";

const io = new Server(httpServer, {
  path: webTunnelPath,
  maxHttpBufferSize: parseIntOrDefault(
    socketConfig.max_http_buffer_size,
    1e8 * 5,
  ),
  ...(realWs && realWs.Server ? { wsEngine: realWs.Server } : {}),
});

httpServer.on("clientError", (err, socket) => {
  if (socket && socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  }
});

io.engine.on("connection_error", (err) => {
  logger.warn(`[Engine.io] connection_error: ${err.message || err}`);
});

// Redis Adapter & Telemetry Storage Setup
const redisConfig = AppConfig.redis;
if (redisConfig && redisConfig.enabled && redisConfig.url) {
  const pubClient = createClient({
    url: redisConfig.url,
    username: redisConfig.username,
    password: redisConfig.password,
    database: redisConfig.database || 0,
  });
  const subClient = pubClient.duplicate();

  pubClient.on("error", (err) =>
    logger.error("[Redis pubClient] error:", err.message),
  );
  subClient.on("error", (err) =>
    logger.error("[Redis subClient] error:", err.message),
  );

  Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
    logger.info(`Redis adapter and telemetry connected: ${redisConfig.url}`);
    io.adapter(createAdapter(pubClient, subClient));
    stats.setRedisClient(pubClient);
  }).catch((err) => {
    logger.error("Failed to connect to Redis:", err.message);
  });
}

// Active tunnel sockets map
const tunnelSockets = {};

// Unified Socket.io Authentication Middleware
io.use((socket, next) => {
  const connectHost = socket.handshake.headers.host;
  const token = socket.handshake.auth && socket.handshake.auth.token;

  if (!token) {
    return next(new Error("[401-NO_TOKEN] Authentication error: Token is required"));
  }

  jwt.verify(token, securityConfig.secret_key, (err, decoded) => {
    if (err) {
      return next(new Error(`[401-VERIFY_ERROR] Authentication error: ${err.message}`));
    }

    if (securityConfig.verify_token && decoded.token !== securityConfig.verify_token) {
      return next(new Error("[401-VERIFY_TOKEN] Authentication error: Invalid verification claim"));
    }

    socket.clientId = decoded.clientId;
    socket.connectHost = connectHost;

    const existsSocket = tunnelSockets[connectHost];
    if (existsSocket && existsSocket.connected) {
      if (
        existsSocket.id === socket.id ||
        socket.handshake.auth?.keep_connection === true
      ) {
        existsSocket.emit(
          "disconnect_exit",
          `socket: ${existsSocket.id} replaced by new connection for host: ${connectHost}`,
        );
        delete tunnelSockets[connectHost];
        stats.deleteStats(connectHost);
        existsSocket.disconnect(true);
        existsSocket.removeAllListeners();
        return next();
      }
      return next(new Error(`[403] Socket has an existing active connection for ${connectHost}`));
    }

    next();
  });
});

io.on("connection", (socket) => {
  const connectHost = socket.handshake.headers.host;
  tunnelSockets[connectHost] = socket;
  logger.info(`client connected at: ${connectHost} (id: ${socket.id})`);

  // Notify cluster primary if in multi-worker mode
  if (process.send) {
    process.send({ type: "REGISTER_HOST", host: connectHost });
  }

  // Record privacy-first connection telemetry
  stats.recordConnect(connectHost);

  const onMessage = (message) => {
    if (message === "ping") {
      socket.send("pong");
    }
  };

  const onDisconnect = (reason) => {
    logger.info(`client disconnected from ${connectHost}:`, reason);
    delete tunnelSockets[connectHost];
    stats.deleteStats(connectHost);

    if (process.send) {
      process.send({ type: "UNREGISTER_HOST", host: connectHost });
    }

    socket.off("message", onMessage);
  };

  socket.on("message", onMessage);
  socket.once("disconnect", onDisconnect);
});

// Middleware
app.use(morgan("common"));

// Basic Health & Info Endpoints
app.get("/_/health", (req, res) => {
  res.sendStatus(200);
});

app.get("/_/info", (req, res) => {
  res.json({
    instance: hostId,
    uptime: process.uptime(),
    build: buildInfo,
  });
});

//////////////////// S Unified Token & Client API ////////////////////
const apiRouter = express.Router();
apiRouter.use(bodyParser.json());

const handleTokenGeneration = (req, res) => {
  const body = req.body || {};
  const clientId = req.query.client || body.clientId || uuidV4();
  const apiKey = req.query.key || body.apiKey || "";

  if (!securityConfig.public_token_registration) {
    if (securityConfig.server_api_key && apiKey !== securityConfig.server_api_key) {
      return res.status(403).json({ error: "Invalid API key" });
    }
  }

  const payload = {
    token: securityConfig.verify_token || "valid",
    clientId: clientId,
    apiKey: apiKey,
  };

  const jwtToken = jwt.sign(payload, securityConfig.secret_key, {
    expiresIn: "30d",
  });

  res.status(200).json({
    token: jwtToken,
    clientId: clientId,
    expiresIn: "30d",
    timestamp: Date.now(),
  });
};

apiRouter.post("/token", handleTokenGeneration);
// Alias for SDK backward compatibility
apiRouter.post("/get_token", handleTokenGeneration);

app.use("/api", apiRouter);
// Backward compatibility alias for /__free__/api/get_token
app.use("/__free__/api", apiRouter);
//////////////////// E Unified Token & Client API ////////////////////

//////////////////// S Admin Console API (Secured with JWT) ////////////////////
const adminRouter = express.Router();
adminRouter.use(bodyParser.json());

// Admin Login (Issues Admin JWT Token)
adminRouter.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  if (username !== adminConfig.username || password !== adminConfig.password) {
    return res.status(401).json({ error: "Invalid admin credentials" });
  }

  const adminToken = jwt.sign(
    { role: "admin", username },
    adminConfig.jwt_secret,
    { expiresIn: adminConfig.jwt_expires_in }
  );

  res.status(200).json({
    token: adminToken,
    expiresIn: adminConfig.jwt_expires_in,
  });
});

// Admin JWT Authentication Middleware
const adminAuthMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Bearer token is required" });
  }

  const token = authHeader.substring(7);
  jwt.verify(token, adminConfig.jwt_secret, (err, decoded) => {
    if (err || !decoded || decoded.role !== "admin") {
      return res.status(401).json({ error: "Unauthorized: Invalid or expired admin token" });
    }
    req.adminUser = decoded;
    next();
  });
};

// Admin Management Endpoints
adminRouter.get("/status", adminAuthMiddleware, async (req, res) => {
  const globalStats = await stats.getGlobalStats();
  res.status(200).json({
    instance: hostId,
    uptime: process.uptime(),
    cpuUsage: process.cpuUsage(),
    memoryUsage: process.memoryUsage(),
    build: buildInfo,
    stats: globalStats,
    activeSocketsCount: Object.keys(tunnelSockets || {}).length,
  });
});

adminRouter.get("/sockets", adminAuthMiddleware, (req, res) => {
  const socketsKeys = Object.keys(tunnelSockets || {});
  res.status(200).json({
    total: socketsKeys.length,
    sockets: socketsKeys.map((host) => {
      const socket = tunnelSockets[host];
      return {
        id: socket.id,
        host: host,
        clientId: socket.clientId || null,
        connected: socket.connected,
        stats: stats.getHostStats(host),
      };
    }),
  });
});

adminRouter.delete("/sockets/:host", adminAuthMiddleware, (req, res) => {
  const host = req.params.host;
  const s = tunnelSockets[host];
  if (s) {
    delete tunnelSockets[host];
    stats.deleteStats(host);
    s.disconnect(true);
  }
  if (process.send) {
    process.send({ type: "UNREGISTER_HOST", host: host });
  }
  res.status(200).json({
    host: host,
    status: "DISCONNECTED",
  });
});

adminRouter.get("/stats", adminAuthMiddleware, async (req, res) => {
  const globalStats = await stats.getGlobalStats();
  res.status(200).json(globalStats);
});

adminRouter.post("/tokens/generate", adminAuthMiddleware, (req, res) => {
  const { clientId, expiresIn } = req.body || {};
  const cid = clientId || uuidV4();
  const token = jwt.sign(
    {
      token: securityConfig.verify_token || "valid",
      clientId: cid,
    },
    securityConfig.secret_key,
    { expiresIn: expiresIn || "30d" }
  );

  res.status(200).json({
    token,
    clientId: cid,
    expiresIn: expiresIn || "30d",
  });
});

app.use("/admin/api", adminRouter);
//////////////////// E Admin Console API ////////////////////

//////////////////// S HTTP Tunnel Client Router ////////////////////
function getReqHeaders(req) {
  const encrypted = !!(
    req.isSpdy ||
    req.connection.encrypted ||
    req.connection.pair
  );

  const headers = { ...req.headers };
  const url = new URL(`${encrypted ? "https" : "http"}://${req.headers.host}`);

  const forwardValues = {
    for: req.connection.remoteAddress || req.socket.remoteAddress,
    port: url.port || (encrypted ? 443 : 80),
    proto: encrypted ? "https" : "http",
  };

  ["for", "port", "proto"].forEach((key) => {
    const previousValue = req.headers[`x-forwarded-${key}`] || "";
    headers[`x-forwarded-${key}`] = `${previousValue || ""}${
      previousValue ? "," : ""
    }${forwardValues[key]}`;
  });

  headers["x-forwarded-host"] =
    req.headers["x-forwarded-host"] || req.headers.host || "";

  return headers;
}

app.use("/", (req, res) => {
  const host = req.headers.host;
  const tunnelSocket = tunnelSockets[host];

  if (!tunnelSocket) {
    res.sendStatus(404);
    return;
  }

  const requestId = uuidV4();
  const tunnelRequest = new TunnelRequest({
    socket: tunnelSocket,
    requestId,
    request: {
      method: req.method,
      headers: getReqHeaders(req),
      path: req.url,
    },
  });

  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });

  const cleanup = (err) => {
    tunnelRequest.destroy(err);
    tunnelResponse.destroy(err);
  };

  req.once("aborted", cleanup);
  req.once("error", cleanup);
  req.pipe(tunnelRequest);

  const onRequestError = (err) => {
    tunnelResponse.off("response", onResponse);
    cleanup(err);
    if (!res.headersSent) {
      res.status(502).end("Bad Gateway / Tunnel Request Error");
    }
  };

  const onResponse = ({ statusCode, statusMessage, headers }) => {
    stats.recordHttp(host);
    tunnelResponse.off("requestError", onRequestError);
    if (!res.headersSent) {
      res.writeHead(statusCode, statusMessage, headers);
    }
  };

  tunnelResponse.once("requestError", onRequestError);
  tunnelResponse.once("response", onResponse);
  tunnelResponse.pipe(res);

  res.once("close", () => {
    if (!res.writableEnded) {
      cleanup(new Error("Response closed prematurely"));
    }
  });
});

function createSocketHttpHeader(line, headers) {
  return (
    Object.keys(headers || {})
      .reduce(
        function (head, key) {
          var value = headers[key];

          if (!Array.isArray(value)) {
            head.push(key + ": " + value);
            return head;
          }

          for (var i = 0; i < value.length; i++) {
            head.push(key + ": " + value[i]);
          }
          return head;
        },
        [line],
      )
      .join("\r\n") + "\r\n\r\n"
  );
}

httpServer.on("upgrade", (req, socket, head) => {
  if (req.url.indexOf(webTunnelPath) === 0) {
    return;
  }
  logger.info(`WS ${req.url}`);

  const host = req.headers.host;
  const tunnelSocket = tunnelSockets[host];

  if (!tunnelSocket) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const requestId = uuidV4();
  const tunnelRequest = new TunnelRequest({
    socket: tunnelSocket,
    requestId,
    request: {
      method: req.method,
      headers: getReqHeaders(req),
      path: req.url,
    },
  });

  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });

  const cleanup = (err) => {
    tunnelRequest.destroy(err);
    tunnelResponse.destroy(err);
    socket.destroy(err);
  };

  const onRequestError = () => {
    tunnelResponse.off("response", onResponse);
    cleanup();
  };

  const onResponse = ({ statusCode, statusMessage, headers, httpVersion }) => {
    stats.recordWs(host);
    tunnelResponse.off("requestError", onRequestError);

    if (statusCode && statusCode !== 101) {
      socket.write(
        createSocketHttpHeader(
          `HTTP/${httpVersion || "1.1"} ${statusCode} ${statusMessage || ""}`,
          headers || {},
        ),
      );
      tunnelResponse.pipe(socket);
      return;
    }

    const responseHeaders = { ...(headers || {}) };
    responseHeaders["Upgrade"] = responseHeaders["upgrade"] || "websocket";
    responseHeaders["Connection"] = responseHeaders["connection"] || "Upgrade";

    socket.write(
      createSocketHttpHeader("HTTP/1.1 101 Switching Protocols", responseHeaders),
    );

    if (head && head.length) {
      tunnelResponse.write(head);
    }

    tunnelResponse.pipe(socket).pipe(tunnelResponse);

    socket.once("error", (err) => cleanup(err));
    socket.once("close", () => cleanup());
    tunnelResponse.once("error", (err) => cleanup(err));
    tunnelResponse.once("close", () => cleanup());
  };

  tunnelResponse.once("requestError", onRequestError);
  tunnelResponse.once("response", onResponse);
});
//////////////////// E HTTP Tunnel Client Router ////////////////////

if (process.env.IS_CLUSTER_WORKER === "true") {
  process.on("message", (msg, socket) => {
    if (msg && msg.type === "STICKY_SOCKET" && socket) {
      if (msg.head) {
        const headBuf = Buffer.isBuffer(msg.head)
          ? msg.head
          : Buffer.from(msg.head.data || msg.head);
        socket.unshift(headBuf);
      }
      socket.resume();
      httpServer.emit("connection", socket);
    }
  });

  httpServer.listen(0, "127.0.0.1", () => {
    logger.info(`[HLT Worker ${process.pid}] ready to receive routed connections`);
  });
} else {
  httpServer.listen(appConfig.port, () => {
    logger.info(
      `http tunnel server starting at: http://localhost:${appConfig.port}, trusted host: ${appConfig.trusted_host}`,
    );
  });
}

// Graceful shutdown handling
const gracefulShutdown = (sig) => {
  logger.info(`[HLT ${hostId}] Received ${sig}, closing server...`);
  httpServer.close(() => {
    logger.info(`[HLT ${hostId}] Server closed cleanly.`);
    process.exit(0);
  });
  setTimeout(() => {
    logger.error(`[HLT ${hostId}] Force exiting on shutdown timeout.`);
    process.exit(1);
  }, 5000);
};

if (process.env.IS_CLUSTER_WORKER !== "true") {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}


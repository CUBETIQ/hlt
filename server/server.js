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

// Active tunnel sockets map and alias resolution
const tunnelSockets = {};
// Map alias -> primary host string
const aliasToPrimaryHost = new Map();
// Set of active primary hosts
const activePrimaryHosts = new Set();

function getSocketAliases(socket) {
  const aliases = new Set();
  const connectHost = socket.handshake.headers.host;
  const auth = socket.handshake.auth || {};
  const headers = socket.handshake.headers || {};

  if (connectHost) {
    aliases.add(connectHost);
    aliases.add(connectHost.split(":")[0]);
  }

  const clientEndpoint = auth.clientEndpoint || headers.clientendpoint || headers["client-endpoint"];
  if (clientEndpoint) {
    aliases.add(clientEndpoint);
    if (clientEndpoint.endsWith("-")) {
      aliases.add(clientEndpoint.slice(0, -1));
    }
  }

  const clientId = socket.clientId || auth.clientId;
  if (clientId) {
    aliases.add(clientId);
  }

  const serverUrl = auth.serverUrl || headers.serverurl;
  if (serverUrl) {
    try {
      const parsed = new URL(serverUrl);
      if (parsed.host) aliases.add(parsed.host);
      if (parsed.hostname) aliases.add(parsed.hostname);
    } catch {}
  }

  return Array.from(aliases).filter(Boolean);
}

function findTunnelSocket(req, { allowLocalFallback = true } = {}) {
  const hostHeader = (req.headers && req.headers.host) || "";
  const host = hostHeader.trim();
  const hostWithoutPort = host.split(":")[0];
  const configuredPort = appConfig.port ? String(appConfig.port) : null;

  // 1. Direct host match in tunnelSockets
  if (host && tunnelSockets[host]) return tunnelSockets[host];
  if (hostWithoutPort && tunnelSockets[hostWithoutPort]) return tunnelSockets[hostWithoutPort];
  if (configuredPort && tunnelSockets[`${hostWithoutPort}:${configuredPort}`]) {
    return tunnelSockets[`${hostWithoutPort}:${configuredPort}`];
  }

  // 2. Check alias map
  if (host && aliasToPrimaryHost.has(host)) {
    const primary = aliasToPrimaryHost.get(host);
    if (primary && tunnelSockets[primary]) return tunnelSockets[primary];
  }
  if (hostWithoutPort && aliasToPrimaryHost.has(hostWithoutPort)) {
    const primary = aliasToPrimaryHost.get(hostWithoutPort);
    if (primary && tunnelSockets[primary]) return tunnelSockets[primary];
  }

  // 3. Forwarded host headers
  const fwdHost = req.headers["x-forwarded-host"] || req.headers["x-tunnel-host"];
  if (fwdHost) {
    const fwdClean = String(fwdHost).split(",")[0].trim();
    const fwdWithoutPort = fwdClean.split(":")[0];
    if (tunnelSockets[fwdClean]) return tunnelSockets[fwdClean];
    if (tunnelSockets[fwdWithoutPort]) return tunnelSockets[fwdWithoutPort];
    if (aliasToPrimaryHost.has(fwdClean) && tunnelSockets[aliasToPrimaryHost.get(fwdClean)]) {
      return tunnelSockets[aliasToPrimaryHost.get(fwdClean)];
    }
    if (aliasToPrimaryHost.has(fwdWithoutPort) && tunnelSockets[aliasToPrimaryHost.get(fwdWithoutPort)]) {
      return tunnelSockets[aliasToPrimaryHost.get(fwdWithoutPort)];
    }
  }

  // 4. Subdomain prefix extraction (e.g. "client1.localhost:3000" or "client1-tunnel.example.com")
  const parts = hostWithoutPort.split(".");
  if (parts.length > 1) {
    const sub = parts[0];
    if (tunnelSockets[sub]) return tunnelSockets[sub];
    if (aliasToPrimaryHost.has(sub) && tunnelSockets[aliasToPrimaryHost.get(sub)]) {
      return tunnelSockets[aliasToPrimaryHost.get(sub)];
    }
    // Subdomain with trailing dash match
    if (tunnelSockets[`${sub}-`]) return tunnelSockets[`${sub}-`];
    if (aliasToPrimaryHost.has(`${sub}-`) && tunnelSockets[aliasToPrimaryHost.get(`${sub}-`)]) {
      return tunnelSockets[aliasToPrimaryHost.get(`${sub}-`)];
    }
  }

  // 5. Explicit client ID query param or header
  const explicitClient = (req.query && (req.query._tunnel || req.query._client)) || req.headers["x-client-id"];
  if (explicitClient) {
    const cKey = String(explicitClient).trim();
    if (tunnelSockets[cKey]) return tunnelSockets[cKey];
    if (aliasToPrimaryHost.has(cKey) && tunnelSockets[aliasToPrimaryHost.get(cKey)]) {
      return tunnelSockets[aliasToPrimaryHost.get(cKey)];
    }
  }

  // 6. Scan active sockets by metadata (clientId, clientEndpoint)
  for (const s of Object.values(tunnelSockets)) {
    if (!s || !s.connected) continue;
    const auth = s.handshake?.auth || {};
    if (auth.clientId === host || auth.clientId === hostWithoutPort) return s;
    if (auth.clientEndpoint === host || auth.clientEndpoint === `${host}-`) return s;
    if (s.clientId === host || s.clientId === hostWithoutPort) return s;
  }

  // 7. Localhost Single-tunnel Fallback:
  // When testing locally (request sent to localhost or 127.0.0.1) and exactly 1 tunnel is connected,
  // route to that tunnel so developers don't need custom local DNS entries!
  const isLocalRequest = hostWithoutPort === "localhost" || hostWithoutPort === "127.0.0.1";
  if (allowLocalFallback && isLocalRequest && activePrimaryHosts.size === 1) {
    const onlyHost = Array.from(activePrimaryHosts)[0];
    if (onlyHost && tunnelSockets[onlyHost]) {
      return tunnelSockets[onlyHost];
    }
  }

  return null;
}

// Client tracking registry
const clientRegistry = new Map();

function registerClientTunnel(clientId, host) {
  const cId = clientId || "anonymous";
  let client = clientRegistry.get(cId);
  if (!client) {
    client = {
      clientId: cId,
      totalTunnelsCreated: 0,
      activeHosts: new Set(),
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    };
    clientRegistry.set(cId, client);
  }
  client.totalTunnelsCreated++;
  client.activeHosts.add(host);
  client.lastSeen = Date.now();
  return client;
}

function unregisterClientTunnel(clientId, host) {
  const cId = clientId || "anonymous";
  const client = clientRegistry.get(cId);
  if (client) {
    client.activeHosts.delete(host);
    client.lastSeen = Date.now();
  }
}

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
      // Only the client that owns the host may take it over. Without this any
      // authenticated client could evict another tenant's tunnel by connecting
      // to its host with keep_connection.
      const sameOwner =
        (existsSocket.clientId || null) === (decoded.clientId || null);
      if (
        existsSocket.id === socket.id ||
        (sameOwner && socket.handshake.auth?.keep_connection === true)
      ) {
        existsSocket.emit(
          "disconnect_exit",
          `socket: ${existsSocket.id} replaced by new connection for host: ${connectHost}`,
        );
        delete tunnelSockets[connectHost];
        activePrimaryHosts.delete(connectHost);
        stats.deleteStats(connectHost);
        unregisterClientTunnel(existsSocket.clientId, connectHost);
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
  const aliases = getSocketAliases(socket);

  tunnelSockets[connectHost] = socket;
  activePrimaryHosts.add(connectHost);

  // Register all aliases pointing to this socket
  aliases.forEach((alias) => {
    tunnelSockets[alias] = socket;
    aliasToPrimaryHost.set(alias, connectHost);
  });

  registerClientTunnel(socket.clientId, connectHost);
  logger.info(`client connected at: ${connectHost} (id: ${socket.id}, client: ${socket.clientId || "anonymous"}, aliases: [${aliases.join(", ")}])`);

  // Notify cluster primary if in multi-worker mode
  if (process.send) {
    process.send({
      type: "REGISTER_HOST",
      host: connectHost,
      aliases: aliases,
      id: socket.id,
      clientId: socket.clientId || null,
    });
  }

  // Record privacy-first connection telemetry
  stats.recordConnect(connectHost);

  const onMessage = (message) => {
    if (message === "ping") {
      socket.send("pong");
    }
  };

  const onDisconnect = (reason) => {
    logger.info(`client disconnected from ${connectHost} (id: ${socket.id}):`, reason);

    // Only clean up if the current registered socket for this host is THIS socket.
    // If a new socket reconnected and replaced tunnelSockets[connectHost], do NOT delete it!
    if (tunnelSockets[connectHost] === socket) {
      delete tunnelSockets[connectHost];
      activePrimaryHosts.delete(connectHost);
      stats.deleteStats(connectHost);
      unregisterClientTunnel(socket.clientId, connectHost);
    }

    aliases.forEach((alias) => {
      if (tunnelSockets[alias] === socket) {
        delete tunnelSockets[alias];
        aliasToPrimaryHost.delete(alias);
      }
    });

    if (process.send) {
      process.send({
        type: "UNREGISTER_HOST",
        host: connectHost,
        aliases,
        socketId: socket.id,
      });
    }

    socket.off("message", onMessage);
  };

  socket.on("message", onMessage);
  socket.once("disconnect", onDisconnect);
});

// Middleware — per-request logging is a measurable cost on the hot tunnel path,
// so it is opt-in (REQUEST_LOG=true).
if (appConfig.request_log) {
  app.use(morgan("common"));
}

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

// Control plane gate: anything that resolves to a tunnel is forwarded straight
// to the tunnel client, so `/admin`, `/api/*` etc. on a tunnel host belong to
// the user's app, not to this server. (`/_/*` above stays reserved.)
// The localhost single-tunnel fallback is deliberately excluded here: on the
// server's own host the admin console must win over that convenience route.
app.use((req, res, next) => {
  if (findTunnelSocket(req, { allowLocalFallback: false })) {
    return handleTunnelRequest(req, res);
  }
  next();
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

// Constant-time compare that does not leak length via an early return.
const crypto = require("crypto");
const safeEqual = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// Simple per-IP throttle on admin login (in-memory, per worker).
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

// Admin Login (Issues Admin JWT Token)
adminRouter.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();

  const entry = loginAttempts.get(ip);
  if (entry && now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
  } else if (entry && entry.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: "Too many failed attempts, try again later" });
  }

  const fail = () => {
    const cur = loginAttempts.get(ip) || { count: 0, first: now };
    cur.count++;
    loginAttempts.set(ip, cur);
    return res.status(401).json({ error: "Invalid admin credentials" });
  };

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  if (!safeEqual(username, adminConfig.username) || !safeEqual(password, adminConfig.password)) {
    return fail();
  }
  loginAttempts.delete(ip);

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

// Cluster IPC Coordination
const pendingClusterRequests = new Map();
if (process.on) {
  process.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "CLUSTER_STATE_RES" && msg.reqId) {
      const cb = pendingClusterRequests.get(msg.reqId);
      if (cb) {
        pendingClusterRequests.delete(msg.reqId);
        cb(msg);
      }
    } else if (msg.type === "DO_DISCONNECT_SOCKET" && msg.host) {
      const s = tunnelSockets[msg.host];
      if (s) {
        try {
          s.emit("disconnect_exit", "Disconnected by administrator");
        } catch {}
        delete tunnelSockets[msg.host];
        stats.deleteStats(msg.host);
        unregisterClientTunnel(s.clientId, msg.host);
        s.disconnect(true);
      }
    }
  });
}

function getClusterState(timeout = 1000) {
  const localSockets = Object.keys(tunnelSockets || {}).map((host) => {
    const socket = tunnelSockets[host];
    return {
      id: socket.id,
      host: host,
      clientId: socket.clientId || null,
      connected: socket.connected,
      stats: stats.getHostStats(host),
    };
  });

  if (!process.send) {
    return Promise.resolve({
      sockets: localSockets,
      clients: null,
      stats: null,
    });
  }

  return new Promise((resolve) => {
    const reqId = uuidV4();
    const timer = setTimeout(() => {
      pendingClusterRequests.delete(reqId);
      resolve({ sockets: localSockets, clients: null, stats: null });
    }, timeout);

    pendingClusterRequests.set(reqId, (res) => {
      clearTimeout(timer);
      resolve(res);
    });

    try {
      process.send({ type: "GET_CLUSTER_STATE", reqId });
    } catch {
      clearTimeout(timer);
      pendingClusterRequests.delete(reqId);
      resolve({ sockets: localSockets, clients: null, stats: null });
    }
  });
}

// Admin Management Endpoints
adminRouter.get("/status", adminAuthMiddleware, async (req, res) => {
  const clusterData = await getClusterState();
  const baseStats = await stats.getGlobalStats();
  const combinedStats = (clusterData.stats && !redisConfig?.enabled)
    ? { ...baseStats, ...clusterData.stats }
    : baseStats;

  res.status(200).json({
    instance: hostId,
    uptime: process.uptime(),
    cpuUsage: process.cpuUsage(),
    memoryUsage: process.memoryUsage(),
    build: buildInfo,
    stats: combinedStats,
    activeSocketsCount: clusterData.sockets.length,
  });
});

adminRouter.get("/sockets", adminAuthMiddleware, async (req, res) => {
  const clusterData = await getClusterState();
  res.status(200).json({
    total: clusterData.sockets.length,
    sockets: clusterData.sockets,
  });
});

adminRouter.delete("/sockets/:host", adminAuthMiddleware, (req, res) => {
  const host = req.params.host;
  const s = tunnelSockets[host];
  if (s) {
    try {
      s.emit("disconnect_exit", "Disconnected by administrator");
    } catch {}
    delete tunnelSockets[host];
    stats.deleteStats(host);
    unregisterClientTunnel(s.clientId, host);
    s.disconnect(true);
  }
  if (process.send) {
    process.send({ type: "UNREGISTER_HOST", host: host });
    process.send({ type: "DISCONNECT_SOCKET_CLUSTER", host: host });
  }
  res.status(200).json({
    host: host,
    status: "DISCONNECTED",
  });
});

adminRouter.get("/clients", adminAuthMiddleware, async (req, res) => {
  const clusterData = await getClusterState();
  if (clusterData.clients && clusterData.clients.length) {
    return res.status(200).json({
      total: clusterData.clients.length,
      clients: clusterData.clients,
    });
  }

  // Fallback / Single-process: aggregate from clientRegistry
  const clientsList = [];
  for (const [cId, cData] of clientRegistry.entries()) {
    const activeHosts = Array.from(cData.activeHosts || []);
    let totalRequests = 0;
    activeHosts.forEach((h) => {
      const hs = stats.getHostStats(h);
      if (hs && hs.requests) totalRequests += hs.requests;
    });
    clientsList.push({
      clientId: cId,
      activeTunnelsCount: activeHosts.length,
      totalTunnelsCreated: cData.totalTunnelsCreated || activeHosts.length,
      activeHosts,
      totalRequests,
      firstSeen: cData.firstSeen,
      lastSeen: cData.lastSeen,
      status: activeHosts.length > 0 ? "online" : "offline",
    });
  }

  // Ensure active tunnel sockets without an entry are also surfaced
  Object.keys(tunnelSockets || {}).forEach((h) => {
    const s = tunnelSockets[h];
    const cId = s.clientId || "anonymous";
    if (!clientRegistry.has(cId)) {
      const hs = stats.getHostStats(h);
      clientsList.push({
        clientId: cId,
        activeTunnelsCount: 1,
        totalTunnelsCreated: 1,
        activeHosts: [h],
        totalRequests: hs?.requests || 0,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        status: "online",
      });
    }
  });

  res.status(200).json({
    total: clientsList.length,
    clients: clientsList,
  });
});

adminRouter.delete("/clients/:clientId", adminAuthMiddleware, (req, res) => {
  const clientId = req.params.clientId;
  let disconnectedCount = 0;

  Object.keys(tunnelSockets || {}).forEach((host) => {
    const s = tunnelSockets[host];
    const cId = s.clientId || "anonymous";
    if (cId === clientId) {
      try {
        s.emit("disconnect_exit", "Client disconnected by administrator");
      } catch {}
      delete tunnelSockets[host];
      stats.deleteStats(host);
      unregisterClientTunnel(s.clientId, host);
      s.disconnect(true);
      disconnectedCount++;
      if (process.send) {
        process.send({ type: "UNREGISTER_HOST", host });
      }
    }
  });

  if (process.send) {
    process.send({ type: "DISCONNECT_CLIENT_CLUSTER", clientId });
  }

  res.status(200).json({
    clientId,
    status: "DISCONNECTED",
    disconnectedCount,
  });
});

adminRouter.get("/stats", adminAuthMiddleware, async (req, res) => {
  const clusterData = await getClusterState();
  const baseStats = await stats.getGlobalStats();
  const combinedStats = (clusterData.stats && !redisConfig?.enabled)
    ? { ...baseStats, ...clusterData.stats }
    : baseStats;
  res.status(200).json(combinedStats);
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

// Serve Web UI Console
const path = require("path");
const fs = require("fs");
const candidateWebPaths = [
  path.join(__dirname, "../web/dist"),
  path.join(__dirname, "./web/dist"),
  path.join(__dirname, "public"),
];
const webDistPath = candidateWebPaths.find((p) => fs.existsSync(p));
if (webDistPath) {
  app.use("/admin", express.static(webDistPath));
  app.get("/admin", (req, res) => {
    res.redirect(301, "/admin/");
  });
  app.use("/admin", (req, res, next) => {
    if (req.method === "GET") {
      return res.sendFile(path.join(webDistPath, "index.html"));
    }
    next();
  });
}
//////////////////// E Admin Console API ////////////////////

//////////////////// S HTTP Tunnel Client Router ////////////////////
function getReqHeaders(req) {
  const encrypted = !!(
    req.isSpdy ||
    req.connection.encrypted ||
    req.connection.pair
  );

  const headers = { ...req.headers };
  const rawHost = req.headers.host || `localhost:${appConfig.port || 3000}`;
  let port = encrypted ? 443 : 80;

  try {
    const url = new URL(`${encrypted ? "https" : "http"}://${rawHost}`);
    if (url.port) {
      port = url.port;
    }
  } catch {}

  const forwardValues = {
    for: req.connection?.remoteAddress || req.socket?.remoteAddress || "127.0.0.1",
    port: port,
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

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function handleTunnelRequest(req, res) {
  const host = req.headers.host || "";
  const tunnelSocket = findTunnelSocket(req);

  if (!tunnelSocket) {
    // Close the connection so a keep-alive socket pinned to this worker is
    // re-dialled (and re-routed) on the next request instead of staying stuck.
    res.set("Connection", "close");
    res.status(404);
    if (req.accepts("html")) {
      res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>404 · Not Found</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      background: #090d16;
      color: #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .panel {
      max-width: 440px;
      width: 100%;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 2rem;
      text-align: left;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.25rem;
    }
    .code {
      display: inline-block;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      color: #f43f5e;
      background: rgba(244, 63, 94, 0.1);
      border: 1px solid rgba(244, 63, 94, 0.25);
      border-radius: 4px;
      padding: 0.2rem 0.5rem;
    }
    h1 {
      font-size: 1.125rem;
      font-weight: 600;
      color: #f8fafc;
    }
    .host {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8125rem;
      color: #38bdf8;
      background: #020617;
      border: 1px solid #1e293b;
      border-radius: 6px;
      padding: 0.625rem 0.875rem;
      margin-bottom: 1rem;
      word-break: break-all;
    }
    p {
      font-size: 0.875rem;
      color: #94a3b8;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <span class="code">404</span>
      <h1>Not Found</h1>
    </div>
    <div class="host">${escapeHtml(host || "unknown-host")}</div>
    <p>No active tunnel client is connected for this address.</p>
  </div>
</body>
</html>`);
    } else {
      res.json({
        error: "Not Found",
        status: 404,
        host: host,
        message: `No active tunnel client connected for host: '${host}'`,
      });
    }
    return;
  }

  const hostKey = tunnelSocket.connectHost || host;
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
    stats.recordHttp(hostKey);
    if (process.send) {
      process.send({ type: "RECORD_HTTP", host: hostKey });
    }
    tunnelResponse.off("requestError", onRequestError);
    if (!res.headersSent) {
      res.writeHead(statusCode, statusMessage, headers);
    }
  };

  tunnelResponse.once("requestError", onRequestError);
  tunnelResponse.once("response", onResponse);
  tunnelResponse.on("error", (err) => {
    cleanup(err);
  });
  tunnelResponse.pipe(res);

  res.once("close", () => {
    if (!res.writableEnded) {
      cleanup(new Error("Response closed prematurely"));
    }
  });
}

app.use("/", handleTunnelRequest);

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

  const host = req.headers.host || "";
  const tunnelSocket = findTunnelSocket(req);

  if (!tunnelSocket) {
    const errorBody = `Not Found: No active tunnel client connected for host '${host}'\r\n`;
    socket.write(
      `HTTP/1.1 404 Not Found\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(errorBody)}\r\n` +
      `Connection: close\r\n\r\n` +
      errorBody
    );
    socket.destroy();
    return;
  }

  const hostKey = tunnelSocket.connectHost || host;
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

  // An upgrade request carries no body. Close it immediately so the client
  // flushes the local request; without this the local request is never sent
  // and the upgrade hangs until timeout. Post-101 traffic flows over
  // tunnelResponse (duplex), not tunnelRequest.
  tunnelRequest.end();

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
    stats.recordWs(hostKey);
    if (process.send) {
      process.send({ type: "RECORD_WS", host: hostKey });
    }
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

    // Node lower-cases incoming headers; adding capitalised keys here would
    // emit a *duplicate* Upgrade/Connection header and clients reject that
    // ("Invalid Upgrade header"). Only fill them in when actually missing.
    const responseHeaders = { ...(headers || {}) };
    const hasHeader = (name) =>
      Object.keys(responseHeaders).some((k) => k.toLowerCase() === name);
    if (!hasHeader("upgrade")) responseHeaders["Upgrade"] = "websocket";
    if (!hasHeader("connection")) responseHeaders["Connection"] = "Upgrade";

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
    if (msg && msg.type === "SHUTDOWN") {
      gracefulShutdown("SHUTDOWN");
      return;
    }
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

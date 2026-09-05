const http = require("http");
const {
  generateUUID: uuidV4,
  parseToBoolean,
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
const { instrument } = require("@socket.io/admin-ui");

const buildInfo = require("./build_info.js");

const sdk = require("./sdk");
const stats = require("./stats");

const hostId = `${require("os").hostname()}#${process.pid}`;
const appConfig = AppConfig.app;
const securityConfig = AppConfig.security;

const app = express();
const adminRouter = express.Router();
const freeRouter = express.Router();
const httpServer = http.createServer(app);

// custom logger
const logger = require("./logger");

// parse application/json
// app.use(bodyParser.json()); // DON'T USE THIS, IT WILL CAUSE ERRORS (Stuck connection, when client request POST)

// HTTP Tunnel Client Routers with Body Parser Support
adminRouter.use(bodyParser.json());
freeRouter.use(bodyParser.json());

const webTunnelPath = "/$cubetiq_http_tunnel";
const servicePrefix = "/__backend__/api";
const freeServicePrefix = "/__free__/api";

const socketConfig = AppConfig.socket;
const io = new Server(httpServer, {
  path: webTunnelPath,
  maxHttpBufferSize: parseIntOrDefault(
    socketConfig.max_http_buffer_size,
    1e8 * 5,
  ), // 5M
  // perMessageDeflate: {
  //   threshold: 2048, // defaults to 1024

  //   zlibDeflateOptions: {
  //     chunkSize: 8 * 1024, // defaults to 16 * 1024
  //   },

  //   zlibInflateOptions: {
  //     windowBits: 14, // defaults to 15
  //     memLevel: 7, // defaults to 8
  //   },

  //   clientNoContextTakeover: true, // defaults to negotiated value.
  //   serverNoContextTakeover: true, // defaults to negotiated value.
  //   serverMaxWindowBits: 10, // defaults to negotiated value.

  // concurrencyLimit: parseIntOrDefault(socketConfig.concurrency_limit, 10), // defaults to 10
  // },
});

const adminConfig = AppConfig.admin;
let adminOpts = undefined;
if (adminConfig && parseToBoolean(adminConfig.enabled)) {
  let auth = undefined;
  if (parseToBoolean(adminConfig.auth_enabled)) {
    auth = {
      type: adminConfig.auth_type,
      username: adminConfig.auth_username,
      password: adminConfig.auth_password,
    };
    logger.info(
      `socket.io admin is enabled with auth type: ${auth.type} and username: ${auth.username}`,
    );
  }

  adminOpts = {
    auth: auth || false,
    namespaceName: adminConfig.namespace,
    serverId: hostId,
  };
}

const redisConfig = AppConfig.redis;
const isRedisEnabled =
  redisConfig && parseToBoolean(redisConfig.enabled) && redisConfig.url;

if (isRedisEnabled) {
  const pubClient = createClient({
    url: redisConfig.url,
    username: redisConfig.username,
    password: redisConfig.password,
    database: redisConfig.database || 0,
  });
  const subClient = pubClient.duplicate();
  const adminClient = pubClient.duplicate();

  pubClient.on("error", (err) =>
    logger.error("[pubClient] redis client error", err),
  );
  subClient.on("error", (err) =>
    logger.error("[subClient] redis client error", err),
  );

  // register redis adapter for socket.io
  Promise.all([
    pubClient.connect(),
    subClient.connect(),
    adminClient.connect(),
  ]).then(() => {
    logger.info(
      `redis pub/sub/admin clients were connected: ${redisConfig.url}`,
    );
    io.adapter(createAdapter(pubClient, subClient));

    // if (adminOpts) {
    //   adminOpts = {
    //     ...adminOpts,
    //     store: new RedisStore(adminClient),
    //   };

    //   // register to socket-admin-ui
    //   instrument(io, adminOpts);
    //   adminClient.clientId().then((clientId) => {
    //     logger.info(
    //       `socket.io admin is enabled with redis client: ${clientId} namespace: ${adminConfig.namespace}`
    //     );
    //   });
    // }
  });
} else {
  // if (adminOpts) {
  //   // register to socket-admin-ui
  //   instrument(io, adminOpts);
  //   logger.info(
  //     `socket.io admin is enabled with namespace: ${adminConfig.namespace}`
  //   );
  // }
}

if (adminOpts) {
  // register to socket-admin-ui
  instrument(io, adminOpts);
  logger.info(
    `socket.io admin is enabled with store: memory and namespace: ${adminConfig.namespace}`,
  );
}

// create empty instance for tunnel sockets
let tunnelSockets = {};

// socket middleware
io.use((socket, next) => {
  const connectHost = socket.handshake.headers.host;
  const isTokenFree = socket.handshake.auth.access === "FREE";
  // logger.info(
  //   `socket connection id: ${socket.id} and is free: ${isTokenFree} from host: ${connectHost}`
  // );

  // SDK:FORKED
  // send details to telemetry (for internal use only)
  sdk.sendToTelemetry({
    client: {
      host: connectHost,
      socketId: socket.id,
      headers: socket.handshake.headers,
      auth: socket.handshake.auth,
      query: JSON.stringify(socket.handshake.query),
      isFree: isTokenFree,
    },
    server: {
      sockets: Object.keys(tunnelSockets || {}),
    },
  });

  if (!socket.handshake.auth || !socket.handshake.auth.token) {
    next(new Error("[401-NO_TOKEN] Authentication error"));
  }

  const secretKey = isTokenFree
    ? securityConfig.free_secret_key
    : process.env.SECRET_KEY;

  // logger.info(
  //   `Load secret key: ${secretKey} and is token free: ${isTokenFree}`
  // );
  jwt.verify(socket.handshake.auth.token, secretKey, function (err, decoded) {
    if (err) {
      return next(new Error(`[401-VERIFY_ERROR] Authentication error: ${err}`));
    }

    const verifyToken =
      decoded.is_free || isTokenFree
        ? securityConfig.free_verify_token
        : process.env.VERIFY_TOKEN;
    if (decoded.token !== verifyToken) {
      return next(new Error("[401-VERIFY_TOKEN] Authentication error"));
    }

    const existsSocket = tunnelSockets[connectHost];
    if (existsSocket && existsSocket.connected) {
      if (
        existsSocket.id === socket.id ||
        socket.handshake.auth?.keep_connection === true
      ) {
        existsSocket.emit(
          "disconnect_exit",
          `socket: ${existsSocket.id} duplicated connection with host: ${connectHost}`,
        );
        delete tunnelSockets[connectHost];
        existsSocket.disconnect(true);
        existsSocket.removeAllListeners();
        return next();
      }
      return next(new Error(`[403] socket has a existing connection`));
    }

    next();
  });
});

io.on("connection", (socket) => {
  const connectHost = socket.handshake.headers.host;
  tunnelSockets[connectHost] = socket;
  logger.info(`client connected at: ${connectHost}`);

  // initialize the stats for connection socket with host
  stats.initStats(connectHost, socket);

  //SDK:FORKED
  sdk.sendConnect({
    client: {
      host: connectHost,
      socketId: socket.id,
      status: "connect",
    },
    server: {
      sockets: Object.keys(tunnelSockets || {}),
    },
  });

  const onMessage = (message) => {
    if (message === "ping") {
      socket.send("pong");
    }
  };

  const onDisconnect = (reason) => {
    logger.info("client disconnected: ", reason);
    delete tunnelSockets[connectHost];
    socket.off("message", onMessage);

    //SDK:FORKED
    sdk.sendDisconnect({
      client: {
        host: connectHost,
        socketId: socket.id,
        status: "disconnect",
        reason: reason,
      },
      server: {
        sockets: Object.keys(tunnelSockets || {}),
      },
    });
  };

  socket.on("message", onMessage);
  socket.once("disconnect", onDisconnect);
});

// Apply ExpressJS middleware
app.use(morgan("common"));

// Basic health check
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

//////////////////// S Custom Router for Back Services ////////////////////
adminRouter.use((req, res, next) => {
  if (req.headers.host !== appConfig.trusted_host) return next("router");
  if (appConfig.trusted_secret) {
    if (req.query.secret !== appConfig.trusted_secret) return next("router");
  }

  next();
});

adminRouter.get("/health", (req, res) => {
  res.sendStatus(200);
});

adminRouter.get("/get_token", (req, res) => {
  if (
    !process.env.JWT_GENERATOR_USERNAME ||
    !process.env.JWT_GENERATOR_PASSWORD
  ) {
    res.sendStatus(404);
    return;
  }

  if (
    req.query.username === process.env.JWT_GENERATOR_USERNAME &&
    req.query.password === process.env.JWT_GENERATOR_PASSWORD
  ) {
    const jwtToken = jwt.sign(
      { token: process.env.VERIFY_TOKEN },
      process.env.SECRET_KEY,
    );

    if (!jwtToken) {
      res.sendStatus(500);
      res.json({ error: "JWT token generation failed" });
      return;
    }

    res.status(200);
    res.json({
      token: jwtToken,
    });

    return;
  }

  res.sendStatus(401);
});

adminRouter.get("/sockets", (req, res) => {
  const socketsKeys = Object.keys(tunnelSockets || {});
  res.status(200);
  res.json({
    instance: {
      id: hostId,
      cpuUsage: process.cpuUsage(),
      memoryUsage: process.memoryUsage(),
    },
    sockets: {
      total: socketsKeys.length,
      hosts: socketsKeys.map((host) => {
        let socket = tunnelSockets[host];
        return {
          id: socket.id,
          host: host,
          status: socket.connected ? "CONNECTED" : "DISCONNECTED",
          stats: stats.getStats(host),
        };
      }),
    },
    status: "OK",
  });
});

adminRouter.delete("/sockets/:host", (req, res) => {
  const host = req.params.host;
  res.status(200);
  res.json({
    host: host,
    status: "DELETED",
  });
});

adminRouter.get("/", (req, res) => {
  res.status(200);
  res.json({
    instance: hostId,
    timestamp: new Date().getTime(),
    status: "OK",
  });
  return;
});

app.use(servicePrefix, adminRouter, (req, res) => {
  res.sendStatus(404);
});
//////////////////// E Custom Router for Back Services ////////////////////

//////////////////// S Custom Router for Free Services ////////////////////
freeRouter.use((req, res, next) => {
  if (req.headers["x-access-type"] !== securityConfig.free_access_type)
    return next("router");
  next();
});

freeRouter.post("/get_token", (req, res) => {
  const body = req.body || {};
  const timestamp = body.timestamp || undefined;
  const client = req.query?.client || body.clientId || "";
  const key = req.query?.key || body.apiKey || "";
  const payload = {
    token: securityConfig.free_verify_token,
    is_free: true,
    client: client,
    key: key,
  };

  const jwtToken = jwt.sign(payload, securityConfig.free_secret_key);

  if (!jwtToken) {
    logger.info("Problem generating token with payload: ", payload);
    res.sendStatus(500);
    res.json({
      error: "generate token error and cannot be signed!",
    });
    return;
  }

  res.status(200);
  res.json({
    client: client,
    token: jwtToken,
    key: key,
    timestamp: timestamp,
  });
});

app.use(freeServicePrefix, freeRouter, (req, res) => {
  res.sendStatus(404);
});
//////////////////// E Custom Router for Free Services ////////////////////

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

  const onReqError = (e) => {
    tunnelRequest.destroy(new Error(e || "Aborted"));
  };

  req.once("aborted", onReqError);
  req.once("error", onReqError);
  req.pipe(tunnelRequest);
  req.once("finish", () => {
    req.off("aborted", onReqError);
    req.off("error", onReqError);
  });

  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });

  const onRequestError = () => {
    tunnelResponse.off("response", onResponse);
    tunnelResponse.destroy();
    res.status(502);
    res.end("Request error");
  };

  const onResponse = ({ statusCode, statusMessage, headers }) => {
    // save stats with http request
    stats.saveStats(host, tunnelSocket);

    tunnelRequest.off("requestError", onRequestError);
    res.writeHead(statusCode, statusMessage, headers);
  };

  tunnelResponse.once("requestError", onRequestError);
  tunnelResponse.once("response", onResponse);
  tunnelResponse.pipe(res);

  const onSocketError = () => {
    res.off("close", onResClose);
    res.status(500);
    res.end("Socket error");
  };

  const onResClose = () => {
    tunnelSocket.off("disconnect", onSocketError);
  };

  tunnelSocket.once("disconnect", onSocketError);
  res.once("close", onResClose);
});

function createSocketHttpHeader(line, headers) {
  return (
    Object.keys(headers)
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

  // proxy websocket request
  const host = req.headers.host;
  const tunnelSocket = tunnelSockets[host];

  if (!tunnelSocket) {
    return;
  }

  if (head && head.length) socket.unshift(head);

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

  req.pipe(tunnelRequest);

  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });

  const onRequestError = () => {
    tunnelResponse.off("response", onResponse);
    tunnelResponse.destroy();
    socket.end();
  };

  const onResponse = ({ statusCode, statusMessage, headers, httpVersion }) => {
    // save stats with http request
    stats.saveStatsWs(host, tunnelSocket);

    tunnelResponse.off("requestError", onRequestError);
    if (statusCode) {
      socket.once("error", (err) => {
        logger.info(`WS ${req.url} ERROR`, err && err.message);
        // ignore error
      });
      // not upgrade event
      socket.write(
        createSocketHttpHeader(
          `HTTP/${httpVersion} ${statusCode} ${statusMessage}`,
          headers,
        ),
      );
      tunnelResponse.pipe(socket);
      return;
    }

    const onSocketError = (err) => {
      logger.info(`WS ${req.url} ERROR`);
      socket.off("end", onSocketEnd);
      tunnelSocket.off("disconnect", onTunnelError);
      tunnelResponse.destroy(err);
    };

    const onSocketEnd = () => {
      logger.info(`WS ${req.url} END`);
      socket.off("error", onSocketError);
      tunnelSocket.off("disconnect", onTunnelError);
      tunnelResponse.destroy();
    };

    const onTunnelError = () => {
      logger.error("Tunnel socket got error!");
      socket.off("error", onSocketError);
      socket.off("end", onSocketEnd);
      socket.end();
      tunnelResponse.destroy();
    };

    socket.once("error", onSocketError);
    socket.once("end", onSocketEnd);
    tunnelSocket.once("disconnect", onTunnelError);

    socket.write(
      createSocketHttpHeader("HTTP/1.1 101 Switching Protocols", headers),
    );

    tunnelResponse.pipe(socket).pipe(tunnelResponse);
  };

  tunnelResponse.once("requestError", onRequestError);
  tunnelResponse.once("response", onResponse);
});
//////////////////// E HTTP Tunnel Client Router ////////////////////

httpServer.listen(appConfig.port);
logger.info(
  `http tunnel server starting at: http://localhost:${appConfig.port}, trusted host: ${appConfig.trusted_host}`,
);

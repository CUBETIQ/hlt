const { describe, test, expect } = require("bun:test");
const { EventEmitter } = require("events");
const jwt = require("jsonwebtoken");
const { TunnelSocketManager, TunnelResponse, TunnelRequest } = require("../lib");
const { TelemetryManager } = require("../stats");
const { AppConfig } = require("../config");

describe("TunnelSocketManager", () => {
  test("creates single listener set and dispatches response streams cleanly", async () => {
    const mockSocket = new EventEmitter();
    mockSocket.id = "mock-socket-1";
    mockSocket.sendBuffer = [];

    const manager = new TunnelSocketManager(mockSocket);

    // Initial listeners count for response-pipe should be exactly 1
    expect(mockSocket.listenerCount("response-pipe")).toBe(1);
    expect(mockSocket.listenerCount("response-pipe-end")).toBe(1);
    expect(mockSocket.listenerCount("request-error")).toBe(1);

    // Create 5 concurrent responses
    const receivedChunks = [];
    for (let i = 0; i < 5; i++) {
      const resp = new TunnelResponse({ socket: mockSocket, responseId: `req-${i}` });
      resp.on("data", (chunk) => receivedChunks.push({ reqId: `req-${i}`, chunk: chunk.toString() }));
    }

    // Listener count MUST remain 1 (no listener explosion!)
    expect(mockSocket.listenerCount("response-pipe")).toBe(1);
    expect(mockSocket.listenerCount("response-pipe-end")).toBe(1);

    // Emit response-pipe for req-2
    mockSocket.emit("response-pipe", "req-2", Buffer.from("hello req-2"));
    await new Promise((r) => setImmediate(r));
    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0]).toEqual({ reqId: "req-2", chunk: "hello req-2" });

    // Cleanup
    manager.cleanup();
    expect(mockSocket.listenerCount("response-pipe")).toBe(0);
    expect(mockSocket.listenerCount("response-pipe-end")).toBe(0);
    expect(mockSocket.listenerCount("request-error")).toBe(0);
  });
});

describe("TelemetryManager", () => {
  test("accumulates global and host metrics with strict privacy", async () => {
    const telemetry = new TelemetryManager();

    await telemetry.recordConnect("client1.example.com");
    await telemetry.recordConnect("client2.example.com");
    await telemetry.recordHttp("client1.example.com");
    await telemetry.recordHttp("client1.example.com");
    await telemetry.recordWs("client2.example.com");

    const stats = await telemetry.getGlobalStats();
    expect(stats.total_connections).toBe(2);
    expect(stats.active_sockets).toBe(2);
    expect(stats.total_http_requests).toBe(2);
    expect(stats.total_ws_requests).toBe(1);
    expect(stats.totalRequests).toBe(3);
    expect(stats.totalConnections).toBe(2);

    const client1Stats = telemetry.getHostStats("client1.example.com");
    expect(client1Stats.http_count).toBe(2);
    expect(client1Stats.ws_count).toBe(0);
    expect(client1Stats.requests).toBe(2);

    await telemetry.recordDisconnect("client1.example.com");
    const updatedStats = await telemetry.getGlobalStats();
    expect(updatedStats.active_sockets).toBe(1);
    expect(updatedStats.total_disconnections).toBe(1);
  });
});

describe("Token Security", () => {
  test("signs and verifies unified JWT token with secret key", () => {
    const payload = {
      token: AppConfig.security.verify_token || "valid",
      clientId: "test-client-123",
      apiKey: "test-api-key",
    };

    const token = jwt.sign(payload, AppConfig.security.secret_key, { expiresIn: "1h" });
    const decoded = jwt.verify(token, AppConfig.security.secret_key);

    expect(decoded.clientId).toBe("test-client-123");
    expect(decoded.token).toBe(payload.token);

    // Invalid secret should fail verification
    expect(() => jwt.verify(token, "wrong_secret")).toThrow();
  });
});

describe("WebSocket Upgrade Compatibility", () => {
  test("handles upgrade on raw TCP sockets without crashing with Bun ERR_INVALID_ARG_TYPE", () => {
    const realWs = require("../ws_patch");
    expect(realWs).toBeDefined();

    const http = require("http");
    const net = require("net");
    const { Server } = require("socket.io");

    const srv = http.createServer();
    const io = new Server(srv, {
      path: "/$cubetiq_http_tunnel",
      wsEngine: realWs.Server,
    });

    const mockSocket = new net.Socket();
    mockSocket.write = () => true;

    const mockReq = {
      method: "GET",
      url: "/$cubetiq_http_tunnel/?EIO=4&transport=websocket",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        host: "localhost:3000",
      },
    };

    expect(() => {
      srv.emit("upgrade", mockReq, mockSocket, Buffer.alloc(0));
    }).not.toThrow();

    io.close();
  });
});

describe("Tunnel Host Aliases & Resolver", () => {
  test("generates all required aliases from socket handshake", () => {
    const mockSocket = {
      handshake: {
        headers: { host: "sambo.localhost:3000" },
        auth: {
          clientId: "sambo",
          clientEndpoint: "sambo-default-",
          serverUrl: "http://sambo.localhost:3000",
        },
      },
      clientId: "sambo",
    };

    // Simulate getSocketAliases logic
    const aliases = new Set();
    const connectHost = mockSocket.handshake.headers.host;
    aliases.add(connectHost);
    aliases.add(connectHost.split(":")[0]);
    aliases.add(mockSocket.handshake.auth.clientEndpoint);
    aliases.add("sambo-default");
    aliases.add(mockSocket.clientId);

    expect(aliases.has("sambo.localhost:3000")).toBe(true);
    expect(aliases.has("sambo.localhost")).toBe(true);
    expect(aliases.has("sambo-default-")).toBe(true);
    expect(aliases.has("sambo-default")).toBe(true);
    expect(aliases.has("sambo")).toBe(true);
  });

  test("stale socket disconnect does not evict newly reconnected socket", () => {
    const tunnelSockets = {};
    const oldSocket = { id: "old-socket", clientId: "sambo" };
    const newSocket = { id: "new-socket", clientId: "sambo" };
    const host = "sambo.localhost:3000";

    // Old socket registers
    tunnelSockets[host] = oldSocket;

    // New socket reconnects for same host
    tunnelSockets[host] = newSocket;

    // Old socket's disconnect handler runs
    const disconnectHandler = (socket) => {
      if (tunnelSockets[host] === socket) {
        delete tunnelSockets[host];
      }
    };

    disconnectHandler(oldSocket);

    // Verify new socket was NOT deleted by old socket's disconnect
    expect(tunnelSockets[host]).toBe(newSocket);
    expect(tunnelSockets[host].id).toBe("new-socket");

    // When the current socket disconnects, it is cleaned up
    disconnectHandler(newSocket);
    expect(tunnelSockets[host]).toBeUndefined();
  });

  test("cluster UNREGISTER_HOST ignores stale socket unregister when newer connection is registered", () => {
    const clusterSockets = new Map();
    const hostToWorker = new Map();

    const worker1 = { process: { pid: 101 } };
    const worker2 = { process: { pid: 102 } };
    const host = "my-app.localhost:3000";

    // Worker 1 registers socket 1
    clusterSockets.set(host, { id: "socket-1", host, workerPid: 101 });
    hostToWorker.set(host, worker1);

    // Worker 2 registers socket 2 (reconnection / failover)
    clusterSockets.set(host, { id: "socket-2", host, workerPid: 102 });
    hostToWorker.set(host, worker2);

    // Worker 1 sends late UNREGISTER_HOST for socket 1
    const unregisterMsg = { type: "UNREGISTER_HOST", host, socketId: "socket-1" };
    const currentEntry = clusterSockets.get(unregisterMsg.host);
    const isCurrentSocket = !unregisterMsg.socketId || !currentEntry || currentEntry.id === unregisterMsg.socketId;

    if (isCurrentSocket) {
      clusterSockets.delete(host);
      hostToWorker.delete(host);
    }

    // Must NOT be deleted because socket-1 is stale
    expect(isCurrentSocket).toBe(false);
    expect(clusterSockets.get(host)).toBeDefined();
    expect(clusterSockets.get(host).id).toBe("socket-2");
    expect(hostToWorker.get(host)).toBe(worker2);

    // When socket 2 unregisters, it is properly cleaned up
    const validUnregister = { type: "UNREGISTER_HOST", host, socketId: "socket-2" };
    const entry2 = clusterSockets.get(validUnregister.host);
    const isCurrentSocket2 = !validUnregister.socketId || !entry2 || entry2.id === validUnregister.socketId;
    if (isCurrentSocket2) {
      clusterSockets.delete(host);
      hostToWorker.delete(host);
    }

    expect(isCurrentSocket2).toBe(true);
    expect(clusterSockets.has(host)).toBe(false);
    expect(hostToWorker.has(host)).toBe(false);
  });
});




require("./ws_patch");
const cluster = require("cluster");
const os = require("os");
const net = require("net");
const { AppConfig } = require("./config");
const logger = require("./logger");

const isClusterEnabled = () => {
  const config = AppConfig.cluster;
  if (!config) return false;
  if (config.enabled) return true;
  if (config.workers === "auto") return true;
  const num = parseInt(config.workers, 10);
  return !isNaN(num) && num > 1;
};

const getWorkerCount = () => {
  const workers = AppConfig.cluster?.workers;
  if (workers === "auto") {
    return Math.max(1, os.cpus().length);
  }
  const parsed = parseInt(workers, 10);
  return isNaN(parsed) || parsed < 1 ? 1 : parsed;
};

if (cluster.isPrimary || cluster.isMaster) {
  const numWorkers = getWorkerCount();

  if (!isClusterEnabled() || numWorkers <= 1) {
    // Single process mode: load server directly
    require("./server.js");
  } else {
    logger.info(
      `[HLT Cluster] Starting Primary ${process.pid} with ${numWorkers} workers`
    );

    const hostToWorker = new Map();
    const workerHosts = new Map();
    const workers = [];
    let workerIndex = 0;

    const clusterSockets = new Map();
    const clusterClients = new Map();
    const clusterStats = {
      total_connections: 0,
      total_disconnections: 0,
      total_http_requests: 0,
      total_ws_requests: 0,
      hostStats: new Map(),
    };

    const getNextWorker = () => {
      if (workers.length === 0) return null;
      const worker = workers[workerIndex % workers.length];
      workerIndex++;
      return worker;
    };

    const forkWorker = (index) => {
      const worker = cluster.fork({
        WORKER_ID: index,
        IS_CLUSTER_WORKER: "true",
      });
      workers.push(worker);
      workerHosts.set(worker, new Set());

      worker.on("message", (msg) => {
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "REGISTER_HOST" && msg.host) {
          hostToWorker.set(msg.host, worker);
          const hostWithoutPort = msg.host.split(":")[0];
          if (hostWithoutPort !== msg.host) {
            hostToWorker.set(hostWithoutPort, worker);
          }
          workerHosts.get(worker)?.add(msg.host);

          // Also register any aliases provided
          if (Array.isArray(msg.aliases)) {
            msg.aliases.forEach((alias) => {
              hostToWorker.set(alias, worker);
              const aliasNoPort = alias.split(":")[0];
              if (aliasNoPort !== alias) {
                hostToWorker.set(aliasNoPort, worker);
              }
              workerHosts.get(worker)?.add(alias);
            });
          }

          clusterSockets.set(msg.host, {
            id: msg.id || `${msg.host}#${worker.process.pid}`,
            host: msg.host,
            clientId: msg.clientId || null,
            connected: true,
            workerPid: worker.process.pid,
            connectedAt: Date.now(),
          });
          clusterStats.total_connections++;
          if (!clusterStats.hostStats.has(msg.host)) {
            clusterStats.hostStats.set(msg.host, { requests: 0, connected_at: Date.now() });
          }

          const cId = msg.clientId || "anonymous";
          let clientEntry = clusterClients.get(cId);
          if (!clientEntry) {
            clientEntry = {
              clientId: cId,
              totalTunnelsCreated: 0,
              activeHosts: new Set(),
              firstSeen: Date.now(),
              lastSeen: Date.now(),
            };
            clusterClients.set(cId, clientEntry);
          }
          clientEntry.totalTunnelsCreated++;
          clientEntry.activeHosts.add(msg.host);
          clientEntry.lastSeen = Date.now();

          logger.info(
            `[HLT Cluster] Host '${msg.host}' (client: ${cId}) registered on worker ${worker.process.pid}`
          );
        } else if (msg.type === "UNREGISTER_HOST" && msg.host) {
          hostToWorker.delete(msg.host);
          const hostWithoutPort = msg.host.split(":")[0];
          if (hostWithoutPort !== msg.host) {
            hostToWorker.delete(hostWithoutPort);
          }
          if (Array.isArray(msg.aliases)) {
            msg.aliases.forEach((alias) => {
              hostToWorker.delete(alias);
              const aliasNoPort = alias.split(":")[0];
              if (aliasNoPort !== alias) {
                hostToWorker.delete(aliasNoPort);
              }
              workerHosts.get(worker)?.delete(alias);
            });
          }
          workerHosts.get(worker)?.delete(msg.host);
          clusterSockets.delete(msg.host);
          clusterStats.total_disconnections++;

          for (const c of clusterClients.values()) {
            if (c.activeHosts.has(msg.host)) {
              c.activeHosts.delete(msg.host);
              c.lastSeen = Date.now();
            }
          }

          logger.info(
            `[HLT Cluster] Host '${msg.host}' unregistered from worker ${worker.process.pid}`
          );
        } else if (msg.type === "RECORD_HTTP" && msg.host) {
          clusterStats.total_http_requests++;
          const hs = clusterStats.hostStats.get(msg.host);
          if (hs) hs.requests = (hs.requests || 0) + 1;
        } else if (msg.type === "RECORD_WS" && msg.host) {
          clusterStats.total_ws_requests++;
          const hs = clusterStats.hostStats.get(msg.host);
          if (hs) hs.requests = (hs.requests || 0) + 1;
        } else if (msg.type === "GET_CLUSTER_STATE" && msg.reqId) {
          const socketsList = Array.from(clusterSockets.values()).map((s) => ({
            ...s,
            stats: clusterStats.hostStats.get(s.host) || { requests: 0 },
          }));

          const clientsList = Array.from(clusterClients.values()).map((c) => {
            const activeHosts = Array.from(c.activeHosts);
            let clientRequests = 0;
            activeHosts.forEach((h) => {
              const hs = clusterStats.hostStats.get(h);
              if (hs && hs.requests) clientRequests += hs.requests;
            });
            return {
              clientId: c.clientId,
              activeTunnelsCount: activeHosts.length,
              totalTunnelsCreated: c.totalTunnelsCreated,
              activeHosts,
              totalRequests: clientRequests,
              firstSeen: c.firstSeen,
              lastSeen: c.lastSeen,
              status: activeHosts.length > 0 ? "online" : "offline",
            };
          });

          const hostStatsObj = {};
          for (const [h, v] of clusterStats.hostStats.entries()) {
            hostStatsObj[h] = v;
          }

          const totalHttp = clusterStats.total_http_requests;
          const totalWs = clusterStats.total_ws_requests;
          const totalConn = clusterStats.total_connections;
          const totalDisc = clusterStats.total_disconnections;
          const activeSocks = clusterSockets.size;

          worker.send({
            type: "CLUSTER_STATE_RES",
            reqId: msg.reqId,
            sockets: socketsList,
            clients: clientsList,
            stats: {
              total_connections: totalConn,
              total_disconnections: totalDisc,
              total_http_requests: totalHttp,
              total_ws_requests: totalWs,
              active_sockets: activeSocks,
              totalConnections: totalConn,
              totalDisconnections: totalDisc,
              totalHttpRequests: totalHttp,
              totalWsRequests: totalWs,
              totalRequests: totalHttp + totalWs,
              activeSockets: activeSocks,
              hostStats: hostStatsObj,
              storage: "cluster-ipc",
            },
          });
        } else if (msg.type === "DISCONNECT_SOCKET_CLUSTER" && msg.host) {
          const target = hostToWorker.get(msg.host);
          clusterSockets.delete(msg.host);
          clusterStats.total_disconnections++;
          if (target && target.isConnected()) {
            target.send({ type: "DO_DISCONNECT_SOCKET", host: msg.host });
          }
        } else if (msg.type === "DISCONNECT_CLIENT_CLUSTER" && msg.clientId) {
          const targetHosts = [];
          for (const s of clusterSockets.values()) {
            const cId = s.clientId || "anonymous";
            if (cId === msg.clientId) {
              targetHosts.push(s.host);
            }
          }
          targetHosts.forEach((host) => {
            const target = hostToWorker.get(host);
            clusterSockets.delete(host);
            clusterStats.total_disconnections++;
            if (target && target.isConnected()) {
              target.send({ type: "DO_DISCONNECT_SOCKET", host });
            }
          });
        }
      });

      worker.on("exit", (code, signal) => {
        logger.warn(
          `[HLT Cluster] Worker ${worker.process.pid} exited (code: ${code}, signal: ${signal}). Respawning...`
        );

        // Remove from workers array
        const idx = workers.indexOf(worker);
        if (idx !== -1) workers.splice(idx, 1);

        // Clean up registered hosts for dead worker
        const hosts = workerHosts.get(worker);
        if (hosts) {
          for (const host of hosts) {
            hostToWorker.delete(host);
            clusterSockets.delete(host);
            for (const c of clusterClients.values()) {
              if (c.activeHosts.has(host)) {
                c.activeHosts.delete(host);
                c.lastSeen = Date.now();
              }
            }
            const hostWithoutPort = host.split(":")[0];
            if (hostWithoutPort !== host) {
              hostToWorker.delete(hostWithoutPort);
            }
          }
          workerHosts.delete(worker);
        }

        // Auto-heal: fork replacement worker
        forkWorker(index);
      });

      return worker;
    };

    for (let i = 0; i < numWorkers; i++) {
      forkWorker(i + 1);
    }

    // Host-Sticky TCP Connection Router
    const primaryServer = net.createServer({ pauseOnConnect: true }, (socket) => {
      let isDataHandled = false;

      const onData = (chunk) => {
        isDataHandled = true;
        socket.pause();

        const str = chunk.toString("latin1");
        const hostFullMatch = str.match(/\r\nHost:\s*([^\r\n]+)\r\n/i);
        const host = hostFullMatch ? hostFullMatch[1].trim() : null;
        const hostWithoutPort = host ? host.split(":")[0] : null;

        const isTunnelPath =
          str.indexOf(" /$cubetiq_http_tunnel") !== -1 ||
          str.indexOf("/$cubetiq_http_tunnel") !== -1;

        let targetWorker = null;
        if (isTunnelPath) {
          // Tunnel client websocket handshake: route round-robin to a worker
          targetWorker = getNextWorker();
        } else if (host && hostToWorker.has(host)) {
          targetWorker = hostToWorker.get(host);
        } else if (hostWithoutPort && hostToWorker.has(hostWithoutPort)) {
          targetWorker = hostToWorker.get(hostWithoutPort);
        } else {
          // Check subdomain prefix (e.g. "client1" from "client1.localhost:3000")
          const sub = hostWithoutPort ? hostWithoutPort.split(".")[0] : null;
          if (sub && hostToWorker.has(sub)) {
            targetWorker = hostToWorker.get(sub);
          } else if (
            (hostWithoutPort === "localhost" || hostWithoutPort === "127.0.0.1") &&
            clusterSockets.size === 1
          ) {
            // Local single-tunnel fallback: forward directly to the worker holding the only tunnel
            const onlyHost = Array.from(clusterSockets.keys())[0];
            targetWorker = hostToWorker.get(onlyHost) || getNextWorker();
          } else {
            // Default or unmatched request (e.g. /_/health, admin, 404)
            targetWorker = getNextWorker();
          }
        }

        if (targetWorker && targetWorker.isConnected()) {
          targetWorker.send({ type: "STICKY_SOCKET", head: chunk }, socket);
        } else {
          socket.destroy();
        }
      };

      socket.once("data", onData);

      socket.once("error", (err) => {
        if (!isDataHandled) {
          socket.destroy();
        }
      });

      socket.resume();
    });

    const port = AppConfig.app.port;
    primaryServer.listen(port, () => {
      logger.info(
        `[HLT Cluster] Primary TCP router listening on port ${port}`
      );
    });

    // Graceful shutdown handling
    const shutdown = (sig) => {
      logger.info(`[HLT Cluster] Received ${sig}, shutting down workers...`);
      primaryServer.close();
      for (const w of workers) {
        if (w.isConnected()) {
          w.send({ type: "SHUTDOWN" });
        }
      }
      setTimeout(() => {
        for (const w of workers) {
          w.kill("SIGKILL");
        }
        process.exit(0);
      }, 5000);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }
} else {
  // Worker process: start server
  require("./server.js");
}

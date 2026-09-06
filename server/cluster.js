require("./ws_patch");
const cluster = require("cluster");
const os = require("os");
const net = require("net");
const { AppConfig } = require("./config");
const { hostSlot } = require("./util");
const { ClaimRegistry } = require("./hostnames");
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
    // Fixed slots: a respawned worker takes the same slot, so hostToSlot stays stable.
    const slots = new Array(numWorkers).fill(null);
    const workers = [];

    // Deterministic host -> worker slot. This is what makes routing truly
    // "host-sticky": a tunnel client reconnecting for the same host always lands
    // on the same worker, so keep-alive browser connections pinned to that worker
    // keep resolving after a client restart.
    const workerForHost = (key) => {
      const preferred = slots[hostSlot(key, slots.length)];
      if (preferred && preferred.isConnected()) return preferred;
      return slots.find((w) => w && w.isConnected()) || null;
    };

    // The primary is the single authority for public tunnel names: workers ask
    // it over IPC so two workers can never grant the same name.
    const claims = new ClaimRegistry();
    const workerClaims = new Map(); // worker -> Set(name), so a crash frees them

    const clusterSockets = new Map();
    const clusterClients = new Map();
    const clusterStats = {
      total_connections: 0,
      total_disconnections: 0,
      total_http_requests: 0,
      total_ws_requests: 0,
      total_bytes_in: 0,
      total_bytes_out: 0,
      hostStats: new Map(),
    };

    // Cumulative per-client history. Entries are never removed: a client that
    // disconnects keeps the traffic it has already served.
    const clientEntry = (clientId) => {
      const cId = clientId || "anonymous";
      let entry = clusterClients.get(cId);
      if (!entry) {
        entry = {
          clientId: cId,
          totalTunnelsCreated: 0,
          activeHosts: new Set(),
          http_count: 0,
          ws_count: 0,
          bytes_in: 0,
          bytes_out: 0,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
        };
        clusterClients.set(cId, entry);
      }
      return entry;
    };

    const forkWorker = (slot) => {
      const worker = cluster.fork({
        WORKER_ID: slot,
        IS_CLUSTER_WORKER: "true",
      });
      workers.push(worker);
      slots[slot] = worker;
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
            aliases: (msg.aliases || []).filter((a) => a !== msg.host),
            connected: true,
            workerPid: worker.process.pid,
            connectedAt: Date.now(),
          });
          clusterStats.total_connections++;
          if (!clusterStats.hostStats.has(msg.host)) {
            clusterStats.hostStats.set(msg.host, { requests: 0, connected_at: Date.now() });
          }

          const cId = msg.clientId || "anonymous";
          const client = clientEntry(cId);
          client.totalTunnelsCreated++;
          client.activeHosts.add(msg.host);
          client.lastSeen = Date.now();

          logger.info(
            `[HLT Cluster] Host '${msg.host}' (client: ${cId}) registered on worker ${worker.process.pid}`
          );
        } else if (msg.type === "UNREGISTER_HOST" && msg.host) {
          const currentEntry = clusterSockets.get(msg.host);
          // If a new connection already replaced this host with a different socket ID or worker, do not evict it!
          const isCurrentSocket = !msg.socketId || !currentEntry || currentEntry.id === msg.socketId;

          if (isCurrentSocket) {
            if (hostToWorker.get(msg.host) === worker) {
              hostToWorker.delete(msg.host);
            }
            const hostWithoutPort = msg.host.split(":")[0];
            if (hostWithoutPort !== msg.host && hostToWorker.get(hostWithoutPort) === worker) {
              hostToWorker.delete(hostWithoutPort);
            }
            if (Array.isArray(msg.aliases)) {
              msg.aliases.forEach((alias) => {
                if (hostToWorker.get(alias) === worker) {
                  hostToWorker.delete(alias);
                }
                const aliasNoPort = alias.split(":")[0];
                if (aliasNoPort !== alias && hostToWorker.get(aliasNoPort) === worker) {
                  hostToWorker.delete(aliasNoPort);
                }
                workerHosts.get(worker)?.delete(alias);
              });
            }
            workerHosts.get(worker)?.delete(msg.host);
            clusterSockets.delete(msg.host);
            clusterStats.hostStats.delete(msg.host);
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
          } else {
            logger.info(
              `[HLT Cluster] Ignored stale unregister for host '${msg.host}' from worker ${worker.process.pid} (replaced by socket ${currentEntry?.id})`
            );
          }
        } else if (msg.type === "CLAIM_HOSTS" && msg.reqId) {
          const result = claims.claim(msg.names || [], msg.clientId || null, msg.socketId);
          if (result.ok) {
            const held = workerClaims.get(worker) || new Set();
            result.names.forEach((n) => held.add(n));
            workerClaims.set(worker, held);
          }
          worker.send({ type: "CLAIM_HOSTS_RES", reqId: msg.reqId, ...result });
        } else if (msg.type === "RELEASE_HOSTS") {
          claims.release(msg.names || [], msg.socketId);
          const held = workerClaims.get(worker);
          if (held) (msg.names || []).forEach((n) => held.delete(n));
        } else if (msg.type === "RECORD_STATS") {
          // Batched counters from a worker's telemetry flush window.
          for (const [host, delta] of Object.entries(msg.hosts || {})) {
            clusterStats.total_http_requests += delta.http || 0;
            clusterStats.total_ws_requests += delta.ws || 0;
            clusterStats.total_bytes_in += delta.in || 0;
            clusterStats.total_bytes_out += delta.out || 0;
            let hs = clusterStats.hostStats.get(host);
            if (!hs) {
              hs = { requests: 0, connected_at: Date.now() };
              clusterStats.hostStats.set(host, hs);
            }
            hs.requests = (hs.requests || 0) + (delta.http || 0) + (delta.ws || 0);
            hs.http_count = (hs.http_count || 0) + (delta.http || 0);
            hs.ws_count = (hs.ws_count || 0) + (delta.ws || 0);
            hs.bytes_in = (hs.bytes_in || 0) + (delta.in || 0);
            hs.bytes_out = (hs.bytes_out || 0) + (delta.out || 0);
          }
          // Client totals are history: they outlive the tunnel that produced them.
          for (const [clientId, delta] of Object.entries(msg.clients || {})) {
            const c = clientEntry(clientId);
            c.http_count += delta.http || 0;
            c.ws_count += delta.ws || 0;
            c.bytes_in += delta.in || 0;
            c.bytes_out += delta.out || 0;
            c.lastSeen = Date.now();
          }
        } else if (msg.type === "FORGET_HOST" && msg.host) {
          // Admin purge: drop the aggregated record, not just the live socket.
          clusterSockets.delete(msg.host);
          clusterStats.hostStats.delete(msg.host);
          for (const c of clusterClients.values()) c.activeHosts.delete(msg.host);
        } else if (msg.type === "FORGET_CLIENT" && msg.clientId) {
          const entry = clusterClients.get(msg.clientId);
          if (entry) {
            for (const host of entry.activeHosts) {
              clusterSockets.delete(host);
              clusterStats.hostStats.delete(host);
            }
            clusterClients.delete(msg.clientId);
          }
          claims.releaseOwner(msg.clientId);
        } else if (msg.type === "FORGET_NAME" && msg.name) {
          claims.deleteName(msg.name);
        } else if (msg.type === "GET_CLUSTER_STATE" && msg.reqId) {
          const socketsList = Array.from(clusterSockets.values()).map((s) => ({
            ...s,
            stats: clusterStats.hostStats.get(s.host) || { requests: 0 },
          }));

          const clientsList = Array.from(clusterClients.values()).map((c) => {
            const activeHosts = Array.from(c.activeHosts);
            return {
              clientId: c.clientId,
              activeTunnelsCount: activeHosts.length,
              totalTunnelsCreated: c.totalTunnelsCreated,
              activeHosts,
              totalRequests: c.http_count + c.ws_count,
              httpRequests: c.http_count,
              wsRequests: c.ws_count,
              bytesIn: c.bytes_in,
              bytesOut: c.bytes_out,
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
              total_bytes_in: clusterStats.total_bytes_in,
              total_bytes_out: clusterStats.total_bytes_out,
              active_sockets: activeSocks,
              totalConnections: totalConn,
              totalDisconnections: totalDisc,
              totalHttpRequests: totalHttp,
              totalWsRequests: totalWs,
              totalRequests: totalHttp + totalWs,
              totalBytesIn: clusterStats.total_bytes_in,
              totalBytesOut: clusterStats.total_bytes_out,
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
        const idx = workers.indexOf(worker);
        if (idx !== -1) workers.splice(idx, 1);

        // Clean up registered hosts for dead worker (only those it still owns)
        const hosts = workerHosts.get(worker);
        if (hosts) {
          for (const host of hosts) {
            if (hostToWorker.get(host) !== worker) continue;
            hostToWorker.delete(host);
            clusterSockets.delete(host);
            clusterStats.hostStats.delete(host);
            for (const c of clusterClients.values()) {
              if (c.activeHosts.has(host)) {
                c.activeHosts.delete(host);
                c.lastSeen = Date.now();
              }
            }
            const hostWithoutPort = host.split(":")[0];
            if (hostWithoutPort !== host && hostToWorker.get(hostWithoutPort) === worker) {
              hostToWorker.delete(hostWithoutPort);
            }
          }
          workerHosts.delete(worker);
        }

        // A crashed worker cannot send RELEASE_HOSTS; free its names here or
        // they stay pinned to a socket that no longer exists.
        const held = workerClaims.get(worker);
        if (held) {
          claims.release(Array.from(held));
          workerClaims.delete(worker);
        }

        if (slots[slot] === worker) slots[slot] = null;
        if (isShuttingDown) return;

        logger.warn(
          `[HLT Cluster] Worker ${worker.process.pid} exited (code: ${code}, signal: ${signal}). Respawning slot ${slot}...`
        );
        forkWorker(slot);
      });

      return worker;
    };

    let isShuttingDown = false;
    for (let i = 0; i < numWorkers; i++) {
      forkWorker(i);
    }

    // Host-Sticky TCP Connection Router
    const MAX_HEADER_PEEK = 64 * 1024;

    const resolveWorker = (head) => {
      const str = head.toString("latin1");
      const hostMatch = str.match(/(?:^|\r?\n)host:\s*([^\r\n]+)/i);
      const host = hostMatch ? hostMatch[1].trim() : "";
      const hostWithoutPort = host.split(":")[0];

      // Tunnel client handshake: hash-only, so the same tunnel host always maps
      // to the same worker across client restarts.
      if (str.indexOf("/$cubetiq_http_tunnel") !== -1) {
        return workerForHost(host);
      }

      if (host && hostToWorker.has(host)) return hostToWorker.get(host);
      if (hostWithoutPort && hostToWorker.has(hostWithoutPort)) {
        return hostToWorker.get(hostWithoutPort);
      }

      // Subdomain prefix (e.g. "client1" from "client1.example.com")
      const sub = hostWithoutPort ? hostWithoutPort.split(".")[0] : null;
      if (sub) {
        if (hostToWorker.has(sub)) return hostToWorker.get(sub);
        if (hostToWorker.has(`${sub}-`)) return hostToWorker.get(`${sub}-`);
        for (const [registeredKey, worker] of hostToWorker.entries()) {
          if (
            registeredKey === sub ||
            registeredKey.startsWith(`${sub}-`) ||
            sub.startsWith(`${registeredKey}-`)
          ) {
            return worker;
          }
        }
      }

      // Local single-tunnel fallback for developers without custom DNS
      if (
        (hostWithoutPort === "localhost" || hostWithoutPort === "127.0.0.1") &&
        clusterSockets.size === 1
      ) {
        const onlyHost = Array.from(clusterSockets.keys())[0];
        return hostToWorker.get(onlyHost) || workerForHost(host);
      }

      // Unmatched (health, admin, 404): still deterministic per host.
      return workerForHost(host);
    };

    const primaryServer = net.createServer({ pauseOnConnect: true }, (socket) => {
      // net.createServer does not disable Nagle the way http.Server does, and the
      // worker inherits this socket as-is: without it every small tunnel frame can
      // sit ~40ms waiting for a delayed ACK.
      socket.setNoDelay(true);
      let head = null;

      const onData = (chunk) => {
        head = head ? Buffer.concat([head, chunk]) : chunk;
        const str = head.toString("latin1");

        // The Host header may not be in the first TCP segment. Keep peeking
        // until we have the full request head (or hit the cap) before routing.
        if (
          str.indexOf("\r\n\r\n") === -1 &&
          !/(?:^|\r?\n)host:\s*[^\r\n]+\r?\n/i.test(str) &&
          head.length < MAX_HEADER_PEEK
        ) {
          socket.once("data", onData);
          return;
        }

        socket.pause();
        socket.setTimeout(0);
        const targetWorker = resolveWorker(head);
        if (targetWorker && targetWorker.isConnected()) {
          targetWorker.send({ type: "STICKY_SOCKET", head }, socket);
        } else {
          socket.destroy();
        }
      };

      socket.once("data", onData);
      socket.once("error", () => socket.destroy());
      socket.setTimeout(30000, () => {
        if (!head) socket.destroy();
      });
      socket.resume();
    });

    const port = AppConfig.app.port;
    primaryServer.on("error", (err) => {
      logger.error(`[HLT Cluster] Primary TCP router failed: ${err.message}`);
      isShuttingDown = true;
      for (const w of workers) w.kill("SIGKILL");
      process.exit(1);
    });
    primaryServer.listen(port, () => {
      logger.info(
        `[HLT Cluster] Primary TCP router listening on port ${port} (${numWorkers} host-sticky workers)`
      );
    });

    // Graceful shutdown handling
    const shutdown = (sig) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info(`[HLT Cluster] Received ${sig}, shutting down workers...`);
      primaryServer.close();
      for (const w of workers) {
        if (w.isConnected()) {
          w.send({ type: "SHUTDOWN" });
        }
      }
      const timer = setInterval(() => {
        if (workers.length === 0) {
          clearInterval(timer);
          process.exit(0);
        }
      }, 200);
      setTimeout(() => {
        for (const w of workers) w.kill("SIGKILL");
        process.exit(0);
      }, 10000).unref?.();
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }
} else {
  // Worker process: start server
  require("./server.js");
}

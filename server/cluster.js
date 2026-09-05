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
          logger.info(
            `[HLT Cluster] Host '${msg.host}' registered on worker ${worker.process.pid}`
          );
        } else if (msg.type === "UNREGISTER_HOST" && msg.host) {
          hostToWorker.delete(msg.host);
          const hostWithoutPort = msg.host.split(":")[0];
          if (hostWithoutPort !== msg.host) {
            hostToWorker.delete(hostWithoutPort);
          }
          workerHosts.get(worker)?.delete(msg.host);
          logger.info(
            `[HLT Cluster] Host '${msg.host}' unregistered from worker ${worker.process.pid}`
          );
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
          // Default or unmatched request (e.g. /_/health, admin, 404)
          targetWorker = getNextWorker();
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

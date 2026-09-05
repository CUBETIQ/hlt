/**
 * Privacy-First Telemetry & Accumulated Stats Manager.
 * Stores only aggregated counters and service metadata in Redis (or in-memory).
 * Strictly guarantees NO collection of user credentials, sensitive headers, or personal data.
 */
class TelemetryManager {
  constructor() {
    this.redisClient = null;
    this.memoryStats = {
      global: {
        total_connections: 0,
        total_disconnections: 0,
        total_http_requests: 0,
        total_ws_requests: 0,
        active_sockets: 0,
        started_at: Date.now(),
      },
      hosts: new Map(),
    };
  }

  setRedisClient(client) {
    this.redisClient = client;
  }

  async recordConnect(host) {
    this.memoryStats.global.total_connections++;
    this.memoryStats.global.active_sockets++;

    const hostEntry = this.memoryStats.hosts.get(host) || {
      http_count: 0,
      ws_count: 0,
    };
    hostEntry.connected_at = Date.now();
    this.memoryStats.hosts.set(host, hostEntry);

    if (this.redisClient && this.redisClient.isOpen) {
      try {
        await Promise.all([
          this.redisClient.hIncrBy("hlt:stats:global", "total_connections", 1),
          this.redisClient.hIncrBy("hlt:stats:global", "active_sockets", 1),
          this.redisClient.sAdd("hlt:stats:active_hosts", host),
          this.redisClient.hSet(`hlt:stats:hosts:${host}`, "connected_at", String(Date.now())),
        ]);
      } catch (err) {
        // Ignore redis non-critical telemetry failure
      }
    }
  }

  async recordDisconnect(host) {
    if (this.memoryStats.global.active_sockets > 0) {
      this.memoryStats.global.active_sockets--;
    }
    this.memoryStats.global.total_disconnections++;
    this.memoryStats.hosts.delete(host);

    if (this.redisClient && this.redisClient.isOpen) {
      try {
        await Promise.all([
          this.redisClient.hIncrBy("hlt:stats:global", "total_disconnections", 1),
          this.redisClient.hIncrBy("hlt:stats:global", "active_sockets", -1),
          this.redisClient.sRem("hlt:stats:active_hosts", host),
          this.redisClient.del(`hlt:stats:hosts:${host}`),
        ]);
      } catch (err) {}
    }
  }

  async recordHttp(host) {
    this.memoryStats.global.total_http_requests++;
    const hostEntry = this.memoryStats.hosts.get(host);
    if (hostEntry) {
      hostEntry.http_count = (hostEntry.http_count || 0) + 1;
    }

    if (this.redisClient && this.redisClient.isOpen) {
      try {
        await Promise.all([
          this.redisClient.hIncrBy("hlt:stats:global", "total_http_requests", 1),
          this.redisClient.hIncrBy(`hlt:stats:hosts:${host}`, "http_count", 1),
        ]);
      } catch (err) {}
    }
  }

  async recordWs(host) {
    this.memoryStats.global.total_ws_requests++;
    const hostEntry = this.memoryStats.hosts.get(host);
    if (hostEntry) {
      hostEntry.ws_count = (hostEntry.ws_count || 0) + 1;
    }

    if (this.redisClient && this.redisClient.isOpen) {
      try {
        await Promise.all([
          this.redisClient.hIncrBy("hlt:stats:global", "total_ws_requests", 1),
          this.redisClient.hIncrBy(`hlt:stats:hosts:${host}`, "ws_count", 1),
        ]);
      } catch (err) {}
    }
  }

  async getGlobalStats() {
    if (this.redisClient && this.redisClient.isOpen) {
      try {
        const redisGlobal = await this.redisClient.hGetAll("hlt:stats:global");
        const activeHosts = await this.redisClient.sMembers("hlt:stats:active_hosts");
        return {
          total_connections: parseInt(redisGlobal.total_connections, 10) || 0,
          total_disconnections: parseInt(redisGlobal.total_disconnections, 10) || 0,
          total_http_requests: parseInt(redisGlobal.total_http_requests, 10) || 0,
          total_ws_requests: parseInt(redisGlobal.total_ws_requests, 10) || 0,
          active_sockets: parseInt(redisGlobal.active_sockets, 10) || 0,
          active_hosts_count: activeHosts.length,
          uptime: process.uptime(),
          storage: "redis",
        };
      } catch (err) {}
    }

    return {
      ...this.memoryStats.global,
      active_hosts_count: this.memoryStats.hosts.size,
      uptime: process.uptime(),
      storage: "memory",
    };
  }

  getHostStats(host) {
    return (
      this.memoryStats.hosts.get(host) || {
        http_count: 0,
        ws_count: 0,
        connected_at: null,
      }
    );
  }

  // Backward-compatible helper aliases
  initStats(host) {
    return this.recordConnect(host);
  }

  saveStats(host) {
    return this.recordHttp(host);
  }

  saveStatsWs(host) {
    return this.recordWs(host);
  }

  deleteStats(host) {
    return this.recordDisconnect(host);
  }

  getStats(host) {
    return this.getHostStats(host);
  }
}

const telemetry = new TelemetryManager();
telemetry.TelemetryManager = TelemetryManager;

module.exports = telemetry;
module.exports.TelemetryManager = TelemetryManager;



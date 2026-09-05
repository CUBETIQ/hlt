const { EventEmitter } = require("events");

/**
 * Privacy-First Telemetry & Accumulated Stats Manager.
 * Stores only aggregated counters and service metadata in Redis (or in-memory).
 * Strictly guarantees NO collection of user credentials, sensitive headers, or personal data.
 *
 * Hot path (recordHttp/recordWs) is synchronous and allocation-free: it bumps
 * in-memory counters and marks the host dirty. Deltas are drained on a timer and
 * announced with a `flush` event, so Redis writes and cluster IPC happen once per
 * window instead of once per request. Connect/disconnect stay on the immediate
 * path — they are rare and carry membership (sAdd/sRem) that must not reorder.
 */
const FLUSH_MS = parseInt(process.env.STATS_FLUSH_MS, 10) || 1000;

class TelemetryManager extends EventEmitter {
  constructor(flushMs = FLUSH_MS) {
    super();
    this.redisClient = null;
    this.flushMs = flushMs;
    this._timer = null;
    this._pending = { http: 0, ws: 0, hosts: new Map() };
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

  _redis() {
    const c = this.redisClient;
    return c && c.isOpen ? c : null;
  }

  _schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.flushMs);
    this._timer.unref?.();
  }

  /** Drain buffered deltas: emits `flush` and pipelines them to Redis. */
  flush() {
    const pending = this._pending;
    if (pending.hosts.size === 0) return;
    this._pending = { http: 0, ws: 0, hosts: new Map() };

    this.emit("flush", pending);

    const redis = this._redis();
    if (!redis) return;
    try {
      const multi = redis.multi();
      if (pending.http) {
        multi.hIncrBy("hlt:stats:global", "total_http_requests", pending.http);
      }
      if (pending.ws) {
        multi.hIncrBy("hlt:stats:global", "total_ws_requests", pending.ws);
      }
      for (const [host, d] of pending.hosts) {
        if (d.http) multi.hIncrBy(`hlt:stats:hosts:${host}`, "http_count", d.http);
        if (d.ws) multi.hIncrBy(`hlt:stats:hosts:${host}`, "ws_count", d.ws);
      }
      multi.exec().catch(() => {});
    } catch {
      // Telemetry is best-effort and must never break the tunnel path.
    }
  }

  _bump(host, field, count) {
    let d = this._pending.hosts.get(host);
    if (!d) {
      d = { http: 0, ws: 0 };
      this._pending.hosts.set(host, d);
    }
    d[field] += count;
    this._pending[field] += count;
    this._schedule();
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

    const redis = this._redis();
    if (redis) {
      try {
        await redis
          .multi()
          .hIncrBy("hlt:stats:global", "total_connections", 1)
          .hIncrBy("hlt:stats:global", "active_sockets", 1)
          .sAdd("hlt:stats:active_hosts", host)
          .hSet(`hlt:stats:hosts:${host}`, "connected_at", String(Date.now()))
          .exec();
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

    const redis = this._redis();
    if (redis) {
      // Flush first so counters for this host are not lost with its hash.
      this.flush();
      try {
        await redis
          .multi()
          .hIncrBy("hlt:stats:global", "total_disconnections", 1)
          .hIncrBy("hlt:stats:global", "active_sockets", -1)
          .sRem("hlt:stats:active_hosts", host)
          .del(`hlt:stats:hosts:${host}`)
          .exec();
      } catch (err) {}
    }
  }

  /** Hot path: synchronous, non-blocking. Flushed in batches. */
  recordHttp(host) {
    this.memoryStats.global.total_http_requests++;
    const hostEntry = this.memoryStats.hosts.get(host);
    if (hostEntry) hostEntry.http_count = (hostEntry.http_count || 0) + 1;
    this._bump(host, "http", 1);
  }

  recordWs(host) {
    this.memoryStats.global.total_ws_requests++;
    const hostEntry = this.memoryStats.hosts.get(host);
    if (hostEntry) hostEntry.ws_count = (hostEntry.ws_count || 0) + 1;
    this._bump(host, "ws", 1);
  }

  async _redisHostStats(redis, hosts) {
    const out = {};
    if (!hosts.length) return out;
    const multi = redis.multi();
    hosts.forEach((h) => multi.hGetAll(`hlt:stats:hosts:${h}`));
    const rows = await multi.exec();
    hosts.forEach((h, i) => {
      const row = rows[i] || {};
      const http = parseInt(row.http_count, 10) || 0;
      const ws = parseInt(row.ws_count, 10) || 0;
      out[h] = {
        requests: http + ws,
        http_count: http,
        ws_count: ws,
        connected_at: parseInt(row.connected_at, 10) || null,
      };
    });
    return out;
  }

  async getGlobalStats() {
    const redis = this._redis();
    if (redis) {
      try {
        // Make this worker's buffered deltas visible before reading back.
        this.flush();
        const [redisGlobal, activeHosts] = await Promise.all([
          redis.hGetAll("hlt:stats:global"),
          redis.sMembers("hlt:stats:active_hosts"),
        ]);
        const totalConn = parseInt(redisGlobal.total_connections, 10) || 0;
        const totalDisc = parseInt(redisGlobal.total_disconnections, 10) || 0;
        const totalHttp = parseInt(redisGlobal.total_http_requests, 10) || 0;
        const totalWs = parseInt(redisGlobal.total_ws_requests, 10) || 0;
        const activeSockets = parseInt(redisGlobal.active_sockets, 10) || 0;
        return {
          total_connections: totalConn,
          total_disconnections: totalDisc,
          total_http_requests: totalHttp,
          total_ws_requests: totalWs,
          active_sockets: activeSockets,
          active_hosts_count: activeHosts.length,
          totalConnections: totalConn,
          totalDisconnections: totalDisc,
          totalHttpRequests: totalHttp,
          totalWsRequests: totalWs,
          totalRequests: totalHttp + totalWs,
          activeSockets: activeSockets,
          activeHostsCount: activeHosts.length,
          hostStats: await this._redisHostStats(redis, activeHosts),
          uptime: process.uptime(),
          storage: "redis",
        };
      } catch (err) {}
    }

    const g = this.memoryStats.global;
    const totalHttp = g.total_http_requests || 0;
    const totalWs = g.total_ws_requests || 0;
    const totalConn = g.total_connections || 0;
    const totalDisc = g.total_disconnections || 0;
    const activeSockets = g.active_sockets || 0;

    const hostStatsObj = {};
    for (const [h, v] of this.memoryStats.hosts.entries()) {
      hostStatsObj[h] = {
        requests: (v.http_count || 0) + (v.ws_count || 0),
        http_count: v.http_count || 0,
        ws_count: v.ws_count || 0,
        connected_at: v.connected_at,
      };
    }

    return {
      ...g,
      totalConnections: totalConn,
      totalDisconnections: totalDisc,
      totalHttpRequests: totalHttp,
      totalWsRequests: totalWs,
      totalRequests: totalHttp + totalWs,
      activeSockets: activeSockets,
      active_hosts_count: this.memoryStats.hosts.size,
      activeHostsCount: this.memoryStats.hosts.size,
      hostStats: hostStatsObj,
      uptime: process.uptime(),
      storage: "memory",
    };
  }

  getHostStats(host) {
    const entry = this.memoryStats.hosts.get(host);
    if (!entry) {
      return {
        requests: 0,
        http_count: 0,
        ws_count: 0,
        connected_at: null,
      };
    }
    return {
      requests: (entry.http_count || 0) + (entry.ws_count || 0),
      http_count: entry.http_count || 0,
      ws_count: entry.ws_count || 0,
      connected_at: entry.connected_at,
    };
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

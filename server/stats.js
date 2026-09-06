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
const NODE_KEY_PREFIX = "hlt:stats:node:";
const NODE_TTL_MS = parseInt(process.env.STATS_NODE_TTL_MS, 10) || 30000;
// Per-host counters are live-tunnel data (client history is the durable record),
// so they are refreshed while the tunnel is up and expire once it is gone.
const HOST_TTL_MS = parseInt(process.env.STATS_HOST_TTL_MS, 10) || 24 * 60 * 60 * 1000;

const emptyDelta = () => ({ http: 0, ws: 0, in: 0, out: 0 });
const newPending = () => ({
  http: 0,
  ws: 0,
  in: 0,
  out: 0,
  hosts: new Map(),
  clients: new Map(),
});

class TelemetryManager extends EventEmitter {
  constructor(flushMs = FLUSH_MS) {
    super();
    this.redisClient = null;
    this.flushMs = flushMs;
    this._timer = null;
    this._nodeTimer = null;
    this.nodeId = null;
    this.getLiveHosts = null;
    this._pending = newPending();
    this.memoryStats = {
      global: {
        total_connections: 0,
        total_disconnections: 0,
        total_http_requests: 0,
        total_ws_requests: 0,
        total_bytes_in: 0,
        total_bytes_out: 0,
        active_sockets: 0,
        started_at: Date.now(),
      },
      hosts: new Map(),
      // Per-client totals survive disconnect on purpose: a tunnel going away
      // must not erase the traffic that client has already pushed through.
      clients: new Map(),
    };
  }

  _client(clientId) {
    const id = clientId || "anonymous";
    let entry = this.memoryStats.clients.get(id);
    if (!entry) {
      entry = {
        clientId: id,
        http_count: 0,
        ws_count: 0,
        bytes_in: 0,
        bytes_out: 0,
        tunnels_created: 0,
        first_seen: Date.now(),
        last_seen: Date.now(),
      };
      this.memoryStats.clients.set(id, entry);
    }
    return entry;
  }

  setRedisClient(client) {
    this.redisClient = client;
    this._heartbeat();
  }

  /**
   * Identify this process and how to ask it for its live tunnel hosts. Each node
   * publishes that list under a short-lived key, so "active tunnels" is the union
   * of what live nodes currently hold: a crashed or restarted node's entries
   * simply expire instead of inflating the numbers forever (which a shared
   * increment/decrement counter always does when a process dies mid-flight).
   */
  setNode(nodeId, getLiveHosts) {
    this.nodeId = nodeId;
    this.getLiveHosts = getLiveHosts;
    this._heartbeat();
  }

  _publishNode() {
    const redis = this._redis();
    if (!redis || !this.nodeId || !this.getLiveHosts) return;
    try {
      const hosts = this.getLiveHosts() || [];
      const multi = redis.multi();
      multi.set(`${NODE_KEY_PREFIX}${this.nodeId}`, JSON.stringify(hosts), {
        PX: NODE_TTL_MS,
      });
      // Keep live host counters alive and let orphans (from a killed process
      // that never disconnected) expire on their own.
      hosts.forEach((h) => multi.pExpire(`hlt:stats:hosts:${h}`, HOST_TTL_MS));
      multi.exec().catch(() => {});
    } catch {}
  }

  _heartbeat() {
    if (this._nodeTimer || !this.nodeId || !this._redis()) return;
    this._publishNode();
    this._nodeTimer = setInterval(() => this._publishNode(), NODE_TTL_MS / 3);
    this._nodeTimer.unref?.();
  }

  /** Live hosts across every node that has checked in recently. */
  async _activeHosts(redis) {
    try {
      const keys = [];
      // The namespace holds one key per running node, so this stays tiny.
      for await (const key of redis.scanIterator({ MATCH: `${NODE_KEY_PREFIX}*`, COUNT: 100 })) {
        keys.push(...(Array.isArray(key) ? key : [key]));
      }
      if (keys.length === 0) return [];
      const rows = await redis.mGet(keys);
      const hosts = new Set();
      for (const row of rows) {
        if (!row) continue;
        try {
          JSON.parse(row).forEach((h) => hosts.add(h));
        } catch {}
      }
      return Array.from(hosts);
    } catch {
      return [];
    }
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
    if (pending.hosts.size === 0 && pending.clients.size === 0) return;
    this._pending = newPending();

    this.emit("flush", pending);

    const redis = this._redis();
    if (!redis) return;
    try {
      const multi = redis.multi();
      const g = (field, value) => {
        if (value) multi.hIncrBy("hlt:stats:global", field, value);
      };
      g("total_http_requests", pending.http);
      g("total_ws_requests", pending.ws);
      g("total_bytes_in", pending.in);
      g("total_bytes_out", pending.out);

      for (const [host, d] of pending.hosts) {
        const key = `hlt:stats:hosts:${host}`;
        if (d.http) multi.hIncrBy(key, "http_count", d.http);
        if (d.ws) multi.hIncrBy(key, "ws_count", d.ws);
        if (d.in) multi.hIncrBy(key, "bytes_in", d.in);
        if (d.out) multi.hIncrBy(key, "bytes_out", d.out);
      }
      // Client rows are the durable history: never deleted on disconnect.
      for (const [clientId, d] of pending.clients) {
        const key = `hlt:clients:${clientId}`;
        if (d.http) multi.hIncrBy(key, "http_count", d.http);
        if (d.ws) multi.hIncrBy(key, "ws_count", d.ws);
        if (d.in) multi.hIncrBy(key, "bytes_in", d.in);
        if (d.out) multi.hIncrBy(key, "bytes_out", d.out);
        multi.hSet(key, "last_seen", String(Date.now()));
      }
      multi.exec().catch(() => {});
    } catch {
      // Telemetry is best-effort and must never break the tunnel path.
    }
  }

  _bumpMap(map, key, field, count) {
    let d = map.get(key);
    if (!d) {
      d = emptyDelta();
      map.set(key, d);
    }
    d[field] += count;
  }

  _bump(host, clientId, field, count) {
    this._bumpMap(this._pending.hosts, host, field, count);
    this._bumpMap(this._pending.clients, clientId || "anonymous", field, count);
    this._pending[field] += count;
    this._schedule();
  }

  async recordConnect(host, clientId) {
    this.memoryStats.global.total_connections++;
    this.memoryStats.global.active_sockets++;

    const hostEntry = this.memoryStats.hosts.get(host) || {
      http_count: 0,
      ws_count: 0,
      bytes_in: 0,
      bytes_out: 0,
    };
    hostEntry.connected_at = Date.now();
    hostEntry.clientId = clientId || hostEntry.clientId || null;
    this.memoryStats.hosts.set(host, hostEntry);

    const client = this._client(clientId);
    client.tunnels_created++;
    client.last_seen = Date.now();

    const redis = this._redis();
    if (redis) {
      const now = String(Date.now());
      const clientKey = `hlt:clients:${clientId || "anonymous"}`;
      try {
        await redis
          .multi()
          .hIncrBy("hlt:stats:global", "total_connections", 1)
          .hSet(`hlt:stats:hosts:${host}`, {
            connected_at: now,
            client_id: String(clientId || "anonymous"),
          })
          .sAdd("hlt:clients", String(clientId || "anonymous"))
          .hIncrBy(clientKey, "tunnels_created", 1)
          .hSet(clientKey, "last_seen", now)
          // NX so the very first connection wins and history keeps its origin.
          .hSetNX(clientKey, "first_seen", now)
          .exec();
      } catch (err) {
        // Ignore redis non-critical telemetry failure
      }
      // Publish the new tunnel set straight away instead of waiting a tick.
      this._publishNode();
    }
  }

  async recordDisconnect(host, clientId) {
    if (this.memoryStats.global.active_sockets > 0) {
      this.memoryStats.global.active_sockets--;
    }
    this.memoryStats.global.total_disconnections++;
    const previous = this.memoryStats.hosts.get(host);
    this.memoryStats.hosts.delete(host);
    this._client(clientId || previous?.clientId).last_seen = Date.now();

    const redis = this._redis();
    if (redis) {
      // Flush first so counters for this host are not lost with its hash.
      this.flush();
      try {
        await redis
          .multi()
          .hIncrBy("hlt:stats:global", "total_disconnections", 1)
          .del(`hlt:stats:hosts:${host}`)
          .exec();
      } catch (err) {}
      this._publishNode();
    }
  }

  /** Hot path: synchronous, non-blocking. Flushed in batches. */
  recordHttp(host, clientId) {
    this.memoryStats.global.total_http_requests++;
    const hostEntry = this.memoryStats.hosts.get(host);
    if (hostEntry) hostEntry.http_count = (hostEntry.http_count || 0) + 1;
    const client = this._client(clientId);
    client.http_count++;
    client.last_seen = Date.now();
    this._bump(host, clientId, "http", 1);
  }

  recordWs(host, clientId) {
    this.memoryStats.global.total_ws_requests++;
    const hostEntry = this.memoryStats.hosts.get(host);
    if (hostEntry) hostEntry.ws_count = (hostEntry.ws_count || 0) + 1;
    const client = this._client(clientId);
    client.ws_count++;
    client.last_seen = Date.now();
    this._bump(host, clientId, "ws", 1);
  }

  /** Bytes proxied for one finished request/WS session. */
  recordTraffic(host, clientId, bytesIn, bytesOut) {
    if (!bytesIn && !bytesOut) return;
    this.memoryStats.global.total_bytes_in += bytesIn;
    this.memoryStats.global.total_bytes_out += bytesOut;

    const hostEntry = this.memoryStats.hosts.get(host);
    if (hostEntry) {
      hostEntry.bytes_in = (hostEntry.bytes_in || 0) + bytesIn;
      hostEntry.bytes_out = (hostEntry.bytes_out || 0) + bytesOut;
    }
    const client = this._client(clientId);
    client.bytes_in += bytesIn;
    client.bytes_out += bytesOut;
    client.last_seen = Date.now();

    if (bytesIn) this._bump(host, clientId, "in", bytesIn);
    if (bytesOut) this._bump(host, clientId, "out", bytesOut);
  }

  /**
   * Cumulative per-client history (Redis-backed when enabled, so it is shared by
   * every worker and survives both disconnects and restarts).
   */
  async getClients() {
    const redis = this._redis();
    if (redis) {
      try {
        this.flush();
        const ids = await redis.sMembers("hlt:clients");
        if (ids.length) {
          const multi = redis.multi();
          ids.forEach((id) => multi.hGetAll(`hlt:clients:${id}`));
          const rows = await multi.exec();
          return ids.map((id, i) => {
            const row = rows[i] || {};
            const http = parseInt(row.http_count, 10) || 0;
            const ws = parseInt(row.ws_count, 10) || 0;
            return {
              clientId: id,
              totalRequests: http + ws,
              httpRequests: http,
              wsRequests: ws,
              bytesIn: parseInt(row.bytes_in, 10) || 0,
              bytesOut: parseInt(row.bytes_out, 10) || 0,
              totalTunnelsCreated: parseInt(row.tunnels_created, 10) || 0,
              firstSeen: parseInt(row.first_seen, 10) || null,
              lastSeen: parseInt(row.last_seen, 10) || null,
            };
          });
        }
        return [];
      } catch (err) {}
    }

    return Array.from(this.memoryStats.clients.values()).map((c) => ({
      clientId: c.clientId,
      totalRequests: c.http_count + c.ws_count,
      httpRequests: c.http_count,
      wsRequests: c.ws_count,
      bytesIn: c.bytes_in,
      bytesOut: c.bytes_out,
      totalTunnelsCreated: c.tunnels_created,
      firstSeen: c.first_seen,
      lastSeen: c.last_seen,
    }));
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
        bytes_in: parseInt(row.bytes_in, 10) || 0,
        bytes_out: parseInt(row.bytes_out, 10) || 0,
        clientId: row.client_id || null,
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
          this._activeHosts(redis),
        ]);
        const totalConn = parseInt(redisGlobal.total_connections, 10) || 0;
        const totalDisc = parseInt(redisGlobal.total_disconnections, 10) || 0;
        const totalHttp = parseInt(redisGlobal.total_http_requests, 10) || 0;
        const totalWs = parseInt(redisGlobal.total_ws_requests, 10) || 0;
        // Derived from live node heartbeats, never from a shared counter: a node
        // that dies without decrementing must not leave phantom tunnels behind.
        const activeSockets = activeHosts.length;
        const bytesIn = parseInt(redisGlobal.total_bytes_in, 10) || 0;
        const bytesOut = parseInt(redisGlobal.total_bytes_out, 10) || 0;
        return {
          total_connections: totalConn,
          total_disconnections: totalDisc,
          total_http_requests: totalHttp,
          total_ws_requests: totalWs,
          total_bytes_in: bytesIn,
          total_bytes_out: bytesOut,
          active_sockets: activeSockets,
          active_hosts_count: activeHosts.length,
          totalConnections: totalConn,
          totalDisconnections: totalDisc,
          totalHttpRequests: totalHttp,
          totalWsRequests: totalWs,
          totalRequests: totalHttp + totalWs,
          totalBytesIn: bytesIn,
          totalBytesOut: bytesOut,
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
      hostStatsObj[h] = this._hostRow(v);
    }

    return {
      ...g,
      totalConnections: totalConn,
      totalDisconnections: totalDisc,
      totalHttpRequests: totalHttp,
      totalWsRequests: totalWs,
      totalRequests: totalHttp + totalWs,
      totalBytesIn: g.total_bytes_in || 0,
      totalBytesOut: g.total_bytes_out || 0,
      activeSockets: activeSockets,
      active_hosts_count: this.memoryStats.hosts.size,
      activeHostsCount: this.memoryStats.hosts.size,
      hostStats: hostStatsObj,
      uptime: process.uptime(),
      storage: "memory",
    };
  }

  _hostRow(entry) {
    return {
      requests: (entry?.http_count || 0) + (entry?.ws_count || 0),
      http_count: entry?.http_count || 0,
      ws_count: entry?.ws_count || 0,
      bytes_in: entry?.bytes_in || 0,
      bytes_out: entry?.bytes_out || 0,
      clientId: entry?.clientId || null,
      connected_at: entry?.connected_at || null,
    };
  }

  getHostStats(host) {
    return this._hostRow(this.memoryStats.hosts.get(host));
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

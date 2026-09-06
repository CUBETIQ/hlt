/**
 * Public tunnel hostname allocation.
 *
 * Two layouts (AppConfig.tunnel.format):
 *   subdomain  TUNNEL_DOMAIN=example.com     ->  <name>.example.com
 *   prefix     TUNNEL_DOMAIN=lt.example.com  ->  <name>-lt.example.com
 *
 * A name is owned by exactly one clientId. Ownership survives a disconnect for
 * claim_ttl_ms so a reconnecting client cannot lose its URL to a racer.
 */
const { AppConfig } = require("./config");

const tunnelConfig = AppConfig.tunnel;

// Names that must never be handed out. Anything that commonly fronts a service
// on the same apex, plus whatever the server itself answers on.
const DEFAULT_RESERVED = [
  "www", "api", "admin", "app", "console", "dashboard", "auth", "login",
  "static", "assets", "cdn", "img", "media", "mail", "smtp", "imap", "ftp",
  "ns", "ns1", "ns2", "dns", "mx", "root", "status", "health", "metrics",
  "grafana", "prometheus", "docs", "blog", "support", "help", "billing",
  "test", "staging", "stage", "dev", "prod", "internal", "private",
  "hlt", "lt", "tunnel", "tunnels", "proxy", "gateway", "cluster",
];

// A DNS label: lowercase alphanumeric plus inner hyphens, 1-63 chars.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Owners that are not a durable client id: a bare connection ("socket:") or a
// specific token ("token:", stable across reconnects but not across re-issues).
// Their claims are never held past the connection, because nothing can prove the
// same client is coming back.
const EPHEMERAL_OWNER = /^(socket|token):/;
const isEphemeralOwner = (owner) => EPHEMERAL_OWNER.test(String(owner || ""));

const reservedSet = new Set([
  ...DEFAULT_RESERVED,
  ...tunnelConfig.reserved,
  // The server's own host label must never be claimable as a tunnel.
  ...String(AppConfig.app.trusted_host || "")
    .split(":")[0]
    .split(".")
    .slice(0, 1)
    .map((s) => s.toLowerCase())
    .filter(Boolean),
]);

const isEnabled = () => Boolean(tunnelConfig.domain);
const separator = () => (tunnelConfig.format === "prefix" ? "-" : ".");
// TUNNEL_DOMAIN may carry a port for local runs (localhost:3000); the port is
// part of the URL but never part of the DNS name we match against.
const domainHost = () => String(tunnelConfig.domain || "").split(":")[0].toLowerCase();

/** Build the public hostname for a name, or null when not configured. */
function buildHost(name) {
  if (!isEnabled()) return null;
  return `${name}${separator()}${tunnelConfig.domain}`;
}

function buildUrl(name) {
  const host = buildHost(name);
  return host ? `${tunnelConfig.scheme}://${host}` : null;
}

/**
 * Recover the name from a hostname the client connected to, so legacy clients
 * (which build their own host) still resolve to a claimable name.
 * Returns null when the host does not belong to this server's tunnel domain.
 */
function parseName(host) {
  if (!isEnabled() || !host) return null;
  const bare = String(host).split(":")[0].toLowerCase();
  const suffix = `${separator()}${domainHost()}`;
  if (!bare.endsWith(suffix)) return null;
  const name = bare.slice(0, -suffix.length);
  return name || null;
}

/**
 * Normalise a requested name. Clients historically append a trailing "-"
 * (e.g. "abc-"), which is not a legal DNS label ending.
 */
function normalizeName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** @returns {string|null} reason the name is unusable, or null when it is fine. */
function validateName(name) {
  if (!name) return "empty name";
  if (name.length > 63) return "name is longer than 63 characters";
  if (!LABEL.test(name)) return "name must be lowercase letters, digits or hyphens";
  if (reservedSet.has(name)) return `'${name}' is reserved`;
  return null;
}

/**
 * name -> { clientId, socketId, lastSeen }. Lives in the cluster primary (or in
 * the single process), so it is the one authority on who owns what.
 */
class ClaimRegistry {
  constructor(ttlMs = tunnelConfig.claim_ttl_ms) {
    this.ttlMs = ttlMs;
    this.claims = new Map();
  }

  /** Drop claims whose owner has been gone longer than the TTL. */
  _expired(entry) {
    return !entry.socketId && this.ttlMs >= 0 && Date.now() - entry.lastSeen > this.ttlMs;
  }

  owner(name) {
    const entry = this.claims.get(name);
    if (!entry) return null;
    if (this._expired(entry)) {
      this.claims.delete(name);
      return null;
    }
    return entry;
  }

  /**
   * Claim names for a client, all-or-nothing. Names are expected to be already
   * normalised and validated by the caller (which knows the addressing mode).
   * @returns {{ok: true, names: string[]} | {ok: false, error: string}}
   */
  claim(names, clientId, socketId) {
    const wanted = [];
    for (const name of names) {
      const held = this.owner(name);
      if (held && held.clientId !== clientId && !isEphemeralOwner(held.clientId)) {
        return { ok: false, error: `'${name}' is already taken` };
      }
      if (!wanted.includes(name)) wanted.push(name);
    }

    if (wanted.length === 0) return { ok: false, error: "no usable name requested" };

    const now = Date.now();
    for (const name of wanted) {
      this.claims.set(name, { clientId, socketId, lastSeen: now });
    }
    return { ok: true, names: wanted };
  }

  /** Mark names as disconnected; they stay reserved for the owner until the TTL. */
  release(names, socketId) {
    for (const name of names || []) {
      const entry = this.claims.get(name);
      // A reconnect may already have re-claimed the name on a new socket.
      if (!entry || (socketId && entry.socketId !== socketId)) continue;
      // Reserving a name for an unidentified client only makes it unusable:
      // nothing can ever prove it is the same client coming back.
      if (this.ttlMs <= 0 || !entry.clientId || isEphemeralOwner(entry.clientId)) {
        this.claims.delete(name);
      } else {
        entry.socketId = null;
        entry.lastSeen = Date.now();
      }
    }
  }

  /** Drop every name owned by a client. Used by the admin purge. */
  releaseOwner(clientId) {
    let removed = 0;
    for (const [name, entry] of this.claims.entries()) {
      if (entry.clientId === clientId) {
        this.claims.delete(name);
        removed++;
      }
    }
    return removed;
  }

  deleteName(name) {
    this.claims.delete(name);
  }

  /** Names currently held by a client (owned, not necessarily connected). */
  listFor(clientId) {
    const out = [];
    for (const [name, entry] of this.claims.entries()) {
      if (entry.clientId === clientId && !this._expired(entry)) out.push(name);
    }
    return out;
  }
}

/**
 * Redis-backed registry: the same contract as ClaimRegistry, but shared by every
 * node. This is what lets a client keep its public URL when it reconnects to a
 * different server than the one it left, and across a full restart.
 *
 * A claim is `hlt:claim:<name> = clientId` with the TTL acting as the grace
 * period. Held names are persisted (no TTL) while the owner is connected and get
 * the TTL back on release, so an owner that disappears frees its name on time.
 *
 * ponytail: SET NX + GET compare, not a Lua CAS. The race window is one round
 * trip and the loser sees "already taken"; move to a script if that ever bites.
 */
class RedisClaimRegistry {
  constructor(redis, ttlMs = tunnelConfig.claim_ttl_ms) {
    this.redis = redis;
    this.ttlMs = ttlMs;
    this.key = (name) => `hlt:claim:${name}`;
  }

  async claim(names, clientId, socketId) {
    // A token with no clientId claim has no durable identity, so its claim is
    // scoped to the connection and must never outlive it (see release()).
    const owner = String(clientId || `socket:${socketId}`);
    const granted = [];

    for (const name of names) {
      if (granted.includes(name)) continue;
      const key = this.key(name);
      try {
        const ok = await this.redis.set(key, owner, { NX: true });
        if (!ok) {
          const held = await this.redis.get(key);
          if (held && held !== owner) {
            // A leftover ephemeral claim belongs to a connection or token that
            // is gone (the owner crashed before releasing). Taking it over is
            // the only way the name ever becomes usable again.
            if (!isEphemeralOwner(held)) {
              return { ok: false, error: `'${name}' is already taken` };
            }
            await this.redis.set(key, owner);
          }
        }
        // Held names never expire while their owner is connected.
        await this.redis.persist(key);
        granted.push(name);
      } catch (err) {
        // `unavailable` tells the caller this is an outage, not a refusal, so it
        // can fall back to the local registry instead of rejecting the client.
        return {
          ok: false,
          unavailable: true,
          error: `claim store unavailable: ${err.message || err.code || err}`,
        };
      }
    }

    if (granted.length === 0) return { ok: false, error: "no usable name requested" };
    return { ok: true, names: granted };
  }

  async release(names) {
    for (const name of names || []) {
      const key = this.key(name);
      try {
        // The grace period is a courtesy to a *identified* client reconnecting.
        // Holding a name for a connection-scoped owner just makes it unusable
        // for the whole TTL, since that owner can never come back.
        const held = await this.redis.get(key);
        if (this.ttlMs <= 0 || !held || isEphemeralOwner(held)) {
          await this.redis.del(key);
        } else {
          await this.redis.pExpire(key, this.ttlMs);
        }
      } catch {
        // The TTL will not be refreshed; the name frees itself either way.
      }
    }
  }

  /** Drop every name owned by a client. Used by the admin purge. */
  async releaseOwner(clientId) {
    const owner = String(clientId);
    let removed = 0;
    try {
      for await (const batch of this.redis.scanIterator({ MATCH: this.key("*"), COUNT: 200 })) {
        const keys = Array.isArray(batch) ? batch : [batch];
        if (keys.length === 0) continue;
        const held = await this.redis.mGet(keys);
        const mine = keys.filter((_, i) => held[i] === owner);
        if (mine.length) {
          await this.redis.del(mine);
          removed += mine.length;
        }
      }
    } catch {
      // Best effort: a claim we cannot reach expires on its own TTL.
    }
    return removed;
  }

  /** Drop one name outright, whoever holds it. */
  async deleteName(name) {
    try {
      await this.redis.del(this.key(name));
    } catch {}
  }
}

/**
 * Which client ids exist, and therefore who may be issued a token for one.
 *
 * A client id is an identity: tunnel names are locked to it, so letting any
 * caller mint a token for an arbitrary id would let one device take over
 * another's names. Once an id has been issued it is only re-issued to a caller
 * that can present a valid token for it (a renewal) or to an operator using the
 * server API key.
 *
 * Redis-backed when available so the rule holds across nodes and restarts;
 * in-memory otherwise (a restart then forgets, which is no worse than before).
 */
class ClientIdRegistry {
  constructor(redis = null) {
    this.redis = redis;
    this.local = new Map();
  }

  key(clientId) {
    return `hlt:id:${clientId}`;
  }

  async exists(clientId) {
    if (this.redis) {
      try {
        return (await this.redis.exists(this.key(clientId))) === 1;
      } catch {
        // Cannot verify: fall back to what this node knows.
      }
    }
    return this.local.has(clientId);
  }

  /** Record the id. Returns false when someone else got there first. */
  async reserve(clientId, meta = {}) {
    const record = { issued_at: String(Date.now()), ...meta };
    if (this.redis) {
      try {
        const fresh = await this.redis.hSetNX(this.key(clientId), "issued_at", record.issued_at);
        await this.redis.hSet(this.key(clientId), { ...record, last_issued_at: record.issued_at });
        this.local.set(clientId, record);
        return fresh === true || fresh === 1;
      } catch {
        // Fall through to the local map.
      }
    }
    const fresh = !this.local.has(clientId);
    this.local.set(clientId, record);
    return fresh;
  }

  async forget(clientId) {
    this.local.delete(clientId);
    if (this.redis) {
      try {
        await this.redis.del(this.key(clientId));
      } catch {}
    }
  }
}

module.exports = {
  isEnabled,
  buildHost,
  buildUrl,
  parseName,
  normalizeName,
  validateName,
  ClaimRegistry,
  RedisClaimRegistry,
  ClientIdRegistry,
  tunnelConfig,
  reservedSet,
};

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
      if (held && held.clientId !== clientId) {
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
      if (this.ttlMs <= 0) {
        this.claims.delete(name);
      } else {
        entry.socketId = null;
        entry.lastSeen = Date.now();
      }
    }
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

module.exports = {
  isEnabled,
  buildHost,
  buildUrl,
  parseName,
  normalizeName,
  validateName,
  ClaimRegistry,
  tunnelConfig,
  reservedSet,
};

/**
 * Override Bun's built-in 'ws' module with the official npm 'ws' package.
 *
 * Bun's built-in 'ws' module replaces 'ws' with a native shim that assumes all
 * WebSockets run directly on native Bun.serve and crashes with
 * "TypeError: upgrade requires a Request object" when sockets are routed via IPC
 * or net.Socket in cluster/proxy mode.
 */
const path = require("path");

let realWs = null;
try {
  const wsPkgPath = require.resolve("ws/package.json");
  realWs = require(path.dirname(wsPkgPath));
  if (realWs) {
    require.cache["ws"] = { exports: realWs, loaded: true, id: "ws" };
  }
} catch (e) {
  try {
    realWs = require("ws");
  } catch (_) {}
}

module.exports = realWs;

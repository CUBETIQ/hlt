// const crypto = require("crypto");

const { v4: uuidV4 } = require("uuid");

const generateUUID = () => {
  return uuidV4(); //crypto.randomUUID();
};

const parseToBoolean = (value) => {
  return value === true || value === "true";
};

const parseIntOrDefault = (value, defaultValue = undefined) => {
  const parsedValue = parseInt(value);
  return isNaN(parsedValue) ? defaultValue : parsedValue;
};

/**
 * Deterministic host -> worker slot (djb2). Must be stable across reconnects:
 * a tunnel client that reconnects has to land on the same worker, otherwise
 * keep-alive connections already pinned to the old worker start 404ing.
 */
const hostSlot = (key, size) => {
  if (!size || size < 1) return 0;
  let h = 5381;
  const s = String(key || "");
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h % size;
};

module.exports = { generateUUID, parseToBoolean, parseIntOrDefault, hostSlot };

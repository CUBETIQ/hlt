import * as crypto from "crypto";

const addPrefixOnHttpSchema = (url: string, prefixDomain: string) => {
  let prefixSubDomain = prefixDomain;
  const prefixSchema = url.substring(0, url.indexOf("://") + 3);
  const splitDomain = url.substring(url.indexOf("://") + 3);

  // if (!prefixSubDomain.endsWith(".")) {
  //   prefixSubDomain = `${prefixSubDomain}.`;
  // }

  // If server's url is localhost or 127.0.0.1 (host with any port)
  if (
    (splitDomain.startsWith("localhost") || splitDomain.startsWith("127.0.0.1")) &&
    prefixSubDomain.endsWith("-")
  ) {
    // remove '-' from prefixSubDomain and replace with '.'
    prefixSubDomain = prefixSubDomain.substring(0, prefixSubDomain.length - 1) + ".";
  }

  return `${prefixSchema}${prefixSubDomain}${splitDomain}`;
};

const generateUUID = () => {
  return crypto.randomUUID();
};

export const isValidUrl = (url: string) => {
  try {
    new URL(url);
    return true;
  } catch (err) {
    return false;
  }
};

export const isValidIP = (ip: string) => {
  const regex = new RegExp(
    "^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\\.|$)){4}$"
  );
  return regex.test(ip);
};

export const isValidHostname = (hostname: string) => {
  const regex = new RegExp(
    "^(?:(?:(?:xn--)?[a-z0-9]+(?:-[a-z0-9]+)*\\.?)+(?:(?:[a-z]{2,}\\.)?[a-z]{2,})|localhost)$",
    "i"
  );
  return regex.test(hostname) || isValidIP(hostname);
};

export const isValidPort = (port: number) => {
  return port > 0 && port < 65536;
};

export const isValidHost = (host: string) => {
  const [hostname, port] = host.split(":");
  return isValidHostname(hostname) && isValidPort(parseInt(port, 10));
};

export const isValidTarget = (target: string) => {
  if (isValidUrl(target)) {
    return true;
  }

  if (isValidHost(target)) {
    return true;
  }

  return false;
};

export const randomPort = () => {
  return Math.floor(Math.random() * 64511) + 1024;
}

/**
 * Read the clientId out of a JWT without verifying it. Used only to name the
 * tunnel when the token is passed with --token and no profile exists — the
 * server re-verifies the signature and remains the authority on identity.
 */
export const decodeTokenClientId = (token?: string): string | null => {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json);
    return typeof claims?.clientId === "string" ? claims.clientId : null;
  } catch {
    return null;
  }
};

export { addPrefixOnHttpSchema, generateUUID };

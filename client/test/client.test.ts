import { describe, test, expect, afterAll } from "bun:test";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TunnelRequest, TunnelResponse } from "../src/lib";
import { HltClient, getToken, SERVER_DEFAULT_URL } from "../src/index";
import { createFileServer } from "../src/serve";
import { decodeTokenClientId } from "../src/util";

describe("HLT Client SDK", () => {
  test("instantiates HltClient with default configuration", () => {
    const client = new HltClient();
    expect(client).toBeDefined();
  });

  test("instantiates HltClient with custom options", () => {
    const client = new HltClient({
      server: "https://custom.hlt.example.com",
      profile: "test-profile",
      clientId: "my-client-id",
      apiKey: "my-secret-key",
      token: "existing-jwt-token",
    });

    expect(client).toBeDefined();
  });

  test("ensureToken returns configured token directly", async () => {
    const client = new HltClient({
      token: "preconfigured-jwt-token",
    });

    const token = await client.ensureToken();
    expect(token).toBe("preconfigured-jwt-token");
  });

  test("reads the client id out of a token without verifying it", () => {
    const payload = Buffer.from(JSON.stringify({ clientId: "acme" })).toString("base64url");
    expect(decodeTokenClientId(`header.${payload}.sig`)).toBe("acme");
    expect(decodeTokenClientId("not-a-jwt")).toBeNull();
    expect(decodeTokenClientId(undefined)).toBeNull();
  });
});

describe("tunnel streams", () => {
  // A visitor aborting mid-response makes the server destroy its side, which
  // arrives here as an error. Without a listener that is an unhandled 'error'
  // event and it takes the whole CLI process down.
  const mockSocket = () => {
    const socket: any = new EventEmitter();
    socket.id = "mock";
    socket.connected = true;
    socket.io = { engine: new EventEmitter() };
    return socket;
  };

  test("a remote error destroys the response without throwing", () => {
    const socket = mockSocket();
    const response = new TunnelResponse(socket, "req-1");

    expect(() => response.handleError("Response closed prematurely")).not.toThrow();
    expect(response.destroyed).toBe(true);
  });

  test("a remote error destroys the request without throwing", () => {
    const socket = mockSocket();
    const request = new TunnelRequest(socket, "req-2");

    expect(() => request.handleError("Response closed prematurely")).not.toThrow();
    expect(request.destroyed).toBe(true);
  });

  test("dispatches a remote error through the socket manager", () => {
    const socket = mockSocket();
    const response = new TunnelResponse(socket, "req-3");

    expect(() => socket.emit("response-pipe-error", "req-3", "boom")).not.toThrow();
    expect(response.destroyed).toBe(true);
  });
});

describe("file server", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hlt-serve-"));
  fs.writeFileSync(path.join(root, "hello.txt"), "0123456789");
  fs.writeFileSync(path.join(os.tmpdir(), "hlt-outside-secret.txt"), "do not serve me");

  const server = createFileServer(root, { auth: "user:pass" });
  const listening = new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port))
  );

  afterAll(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = async (url: string, init?: RequestInit) => {
    const port = await listening;
    return fetch(`http://127.0.0.1:${port}${url}`, {
      ...init,
      headers: {
        authorization: "Basic " + Buffer.from("user:pass").toString("base64"),
        ...(init?.headers || {}),
      },
    });
  };

  test("requires auth when configured", async () => {
    const port = await listening;
    const res = await fetch(`http://127.0.0.1:${port}/hello.txt`);
    expect(res.status).toBe(401);
  });

  test("serves a file and honours Range", async () => {
    expect(await (await get("/hello.txt")).text()).toBe("0123456789");

    const ranged = await get("/hello.txt", { headers: { range: "bytes=2-4" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await ranged.text()).toBe("234");
  });

  test("cannot escape the served root", async () => {
    for (const attempt of [
      "/../hlt-outside-secret.txt",
      "/%2e%2e/hlt-outside-secret.txt",
      "/sub/../../hlt-outside-secret.txt",
    ]) {
      const res = await get(attempt);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain("do not serve me");
    }
  });

  test("rejects writes", async () => {
    expect((await get("/hello.txt", { method: "POST" })).status).toBe(405);
  });
});

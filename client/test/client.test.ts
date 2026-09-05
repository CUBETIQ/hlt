import { describe, test, expect } from "bun:test";
import { HltClient, getToken, SERVER_DEFAULT_URL } from "../src/index";

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
});

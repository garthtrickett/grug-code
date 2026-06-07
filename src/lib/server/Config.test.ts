import { describe, it, expect, vi, afterEach } from "vitest";

describe("Server Config Unit Checks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("should load openai config correctly from process.env", async () => {
    const { config } = await import("./Config.ts");
    expect(config.openai).toBeDefined();
    expect(typeof config.openai.apiKey).toBe("string");
  });

  it("should fall back to default surgical limits when environment variables are omitted", async () => {
    vi.stubEnv("SURGICAL_ROUTER_FILE_LIMIT", "");
    vi.stubEnv("SURGICAL_ROUTER_TOKEN_LIMIT", "");
    vi.resetModules();
    const { config } = await import("./Config.ts");
    expect(config.surgical).toBeDefined();
    expect(config.surgical.fileLimit).toBe(3);
    expect(config.surgical.tokenLimit).toBe(20000);
  });

  it("should correctly parse custom surgical limits set via environment variables", async () => {
    vi.stubEnv("SURGICAL_ROUTER_FILE_LIMIT", "10");
    vi.stubEnv("SURGICAL_ROUTER_TOKEN_LIMIT", "100000");
    vi.resetModules();
    const { config } = await import("./Config.ts");
    expect(config.surgical).toBeDefined();
    expect(config.surgical.fileLimit).toBe(10);
    expect(config.surgical.tokenLimit).toBe(100000);
  });

  it("should fall back to default surgical socket path when environment variables are omitted", async () => {
    vi.stubEnv("SURGICAL_ROUTER_SOCKET_PATH", "");
    vi.resetModules();
    const { config } = await import("./Config.ts");
    expect(config.surgical).toBeDefined();
    expect(config.surgical.socketPath).toContain("grug.sock");
  });

  it("should correctly parse custom surgical socket path set via environment variables", async () => {
    vi.stubEnv("SURGICAL_ROUTER_SOCKET_PATH", "/tmp/custom_grug_test.sock");
    vi.resetModules();
    const { config } = await import("./Config.ts");
    expect(config.surgical).toBeDefined();
    expect(config.surgical.socketPath).toBe("/tmp/custom_grug_test.sock");
  });
});

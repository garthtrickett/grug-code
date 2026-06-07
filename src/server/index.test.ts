import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

describe("Elysia Companion Server - UDS Bootstrapping Integration", () => {
  let testSocketPath: string;

  beforeAll(() => {
    testSocketPath = path.resolve(`/tmp/grug-test-${randomUUID()}.sock`);
    process.env.SURGICAL_ROUTER_SOCKET_PATH = testSocketPath;
  });

  afterAll(() => {
    try {
      if (fs.existsSync(testSocketPath)) {
        fs.unlinkSync(testSocketPath);
      }
    } catch {}
  });

  it("should instantiate both listeners, verify access rights, and unlink the socket file cleanly on stop", async () => {
    // Dynamically import to ensure environment variable override is evaluated correctly on import
    const { app, udsApp } = await import("./index.ts");

    // Start TCP server on dynamic port (0) to prevent port collisions
    const serverTcp = app.listen(0);
    expect(serverTcp.server?.port ?? 0).toBeGreaterThan(0);

    // Prepare socket path directory and pre-clean socket file
    try {
      const dir = path.dirname(testSocketPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(testSocketPath)) {
        fs.unlinkSync(testSocketPath);
      }
    } catch {}

        // Start UDS server
    const serverUds = udsApp.listen({ unix: testSocketPath });
    expect(serverUds.server).toBeDefined();

    // Verify socket file was created
    expect(fs.existsSync(testSocketPath)).toBe(true);

    // Verify access rights on the socket file
    let hasAccess = false;
    try {
      fs.accessSync(testSocketPath, fs.constants.R_OK | fs.constants.W_OK);
      hasAccess = true;
    } catch (err) {
      console.error("Socket access verification failed:", err);
    }
    expect(hasAccess).toBe(true);

    // Stop both listeners
    await serverTcp.stop();
    await serverUds.stop();

    // Verify socket file was cleanly unlinked
    expect(fs.existsSync(testSocketPath)).toBe(false);
  });
});

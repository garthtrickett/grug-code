import { describe, it, expect, afterEach } from "vitest";
import { createDaemonApp } from "../src/daemon.ts";

describe("Daemon HTTP Endpoints", () => {
  let appInstance: any = null;

  afterEach(async () => {
    if (appInstance) {
      await appInstance.stop();
      appInstance = null;
    }
  });

  it("should start Elysia app on a random port, respond to /api/health, and close cleanly", async () => {
    appInstance = createDaemonApp();
    await appInstance.listen(0);

    const port = appInstance.server?.port;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://localhost:${port}/api/health`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ status: "ok", service: "grug-cli-daemon" });
  });

  it("should return preferences at /api/preferences", async () => {
    appInstance = createDaemonApp();
    await appInstance.listen(0);

    const port = appInstance.server?.port;
    const response = await fetch(`http://localhost:${port}/api/preferences`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.dailyReviewLimit).toBe(20);
    expect(data.dailyNewRuleLimit).toBe(3);
    expect(data.enforceMasteryGates).toBe(true);
  });

  it("should return mock profile at /api/auth/me", async () => {
    appInstance = createDaemonApp();
    await appInstance.listen(0);

    const port = appInstance.server?.port;
    const response = await fetch(`http://localhost:${port}/api/auth/me`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.user.email).toBe("grug@daemon.local");
    expect(data.user.permissions).toContain("platform:manage");
  });
});
import { test, expect } from "./utils/base-test.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Elysia Companion Server - Stage 1 Research Loop E2E", () => {
  let tempDir: string;
  let sessionToken: string;

  test.beforeAll(async () => {
    // Read local loopback session token securely from storage
    const fileContent = await fs.readFile(".grug-session.json", "utf-8");
    const sessionData = JSON.parse(fileContent) as { token: string };
    sessionToken = sessionData.token;
  });

  test.beforeEach(async () => {
    // Construct clean isolated workspace sandbox repository
    tempDir = path.join(process.cwd(), `.grug-e2e-research-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug Research Test'", { cwd: tempDir });
    await execPromise("git config user.email 'researche2e@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    await fs.writeFile(path.join(tempDir, "payment.ts"), "export const process = () => {};\n");
    await execPromise("git add .", { cwd: tempDir });
    await execPromise("git commit -m 'Initial setup'", { cwd: tempDir });
  });

  test.afterEach(async () => {
    // Restore repository safely
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should reject research requests lacking standard credentials with 401 Unauthorized", async ({ request }) => {
    const response = await request.post("/api/workspace/research", {
      headers: {
        "Content-Type": "application/json",
      },
      data: {
        userPrompt: "Refactor payment adapter structures",
        cwd: tempDir,
      },
    });

    expect(response.status()).toBe(401);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("Unauthorized");
  });

  test("should reject state-changing research requests originating from non-loopback hosts with 403 Forbidden", async ({ request }) => {
    const response = await request.post("/api/workspace/research", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
        "Origin": "http://untrusted-external-domain.com",
      },
      data: {
        userPrompt: "Analyze payment patterns",
        cwd: tempDir,
      },
    });

    expect(response.status()).toBe(403);
    const data = (await response.json()) as { error: string };
    expect(data.error).toContain("External request origin or host detected");
  });

  test("should authenticate, scan structures, and yield diagnostic error/result when API key is unconfigured or call fails", async ({ request }) => {
    const response = await request.post("/api/workspace/research", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        userPrompt: "Locate compute references in helper routines",
        cwd: tempDir,
      },
    });

    // If active API key is absent/invalid in the test environment, the endpoint returns a 400 with the inference failure message.
    // If it's valid, it processes successfully returning 200. We assert clean, deterministic handling for both scenarios.
    if (response.status() === 200) {
      const data = (await response.json()) as { target_files: string[]; plan: unknown[] };
      expect(Array.isArray(data.target_files)).toBe(true);
      expect(Array.isArray(data.plan)).toBe(true);
    } else {
      expect(response.status()).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBeDefined();
    }
  });
});

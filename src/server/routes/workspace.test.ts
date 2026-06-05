import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { app } from "../index";
import { getActiveToken } from "../middleware/security";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

describe("Elysia Companion Server - Workspace endpoints", () => {
  let tempDir: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    // Prepare temporary repository for HTTP mock testing
    tempDir = path.join(originalCwd, `.grug-api-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug API Test'", { cwd: tempDir });
    await execPromise("git config user.email 'api@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Original codebase line.\n");
    await execPromise("git add initial.txt", { cwd: tempDir });
    await execPromise("git commit -m 'initial api commit'", { cwd: tempDir });

    // Temporarily change process.cwd() so the controller points to our test repo
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should reject requests without a valid security token", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/workspace/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ taskId: "api-task-id" }),
      })
    );

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("Unauthorized");
  });

  it("should accept requests with the valid token and spawn transaction", async () => {
    const token = getActiveToken();
    const response = await app.handle(
      new Request("http://localhost/api/workspace/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({ taskId: "api-task-id" }),
      })
    );

    expect(response.status).toBe(200);
    const tx = await response.json();
    expect(tx.ephemeralBranch).toBe("grug-task/api-task-id");

    // Abort to clean up git state
    const abortResponse = await app.handle(
      new Request("http://localhost/api/workspace/abort", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({ tx }),
      })
    );
    expect(abortResponse.status).toBe(200);
  });
});

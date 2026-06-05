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
    tempDir = path.join(originalCwd, `.grug-api-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug API Test'", { cwd: tempDir });
    await execPromise("git config user.email 'api@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Original codebase line.\n");
    await execPromise("git add initial.txt", { cwd: tempDir });
    await execPromise("git commit -m 'initial api commit'", { cwd: tempDir });

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

  it("should reject state-changing requests from non-loopback hosts with 403 Forbidden", async () => {
    const token = getActiveToken();
    const response = await app.handle(
      new Request("http://malicious.com/api/workspace/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
          "Host": "malicious.com"
        },
        body: JSON.stringify({ taskId: "api-task-id" }),
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain("External request origin or host detected");
  });

  it("should accept requests with the valid token and apply patches natively", async () => {
    const token = getActiveToken();
    
    const initResponse = await app.handle(
      new Request("http://localhost/api/workspace/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({ taskId: "api-patch-task-id" }),
      })
    );

    expect(initResponse.status).toBe(200);
    const tx = await initResponse.json();
    expect(tx.ephemeralBranch).toBe("grug-task/api-patch-task-id");

    const patchResponse = await app.handle(
      new Request("http://localhost/api/workspace/patch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          tx,
          patch: {
            summary: "Update original file",
            files: [
              {
                file_path: "initial.txt",
                code_diff: `
<<<<<<< SEARCH
Original codebase line.
=======
Patched via REST API.
>>>>>>> REPLACE
`
              }
            ]
          }
        }),
      })
    );

    expect(patchResponse.status).toBe(200);
    const patchResult = await patchResponse.json();
    expect(patchResult.success).toBe(true);

    const content = await fs.readFile(path.join(tempDir, "initial.txt"), "utf-8");
    expect(content).toBe("Patched via REST API.\n");

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

  it("should return a structured 400 error with diagnostic metadata on mismatched patch requests", async () => {
    const token = getActiveToken();

    const initResponse = await app.handle(
      new Request("http://localhost/api/workspace/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({ taskId: "api-mismatch-task-id" }),
      })
    );

    expect(initResponse.status).toBe(200);
    const tx = await initResponse.json();

    const patchResponse = await app.handle(
      new Request("http://localhost/api/workspace/patch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          tx,
          patch: {
            summary: "Mismatched update",
            files: [
              {
                file_path: "initial.txt",
                code_diff: `\n<<<<<<< SEARCH\nThis line is totally wrong and doesn't exist on disk.\n=======\nLine after replacement.\n>>>>>>> REPLACE\n`
              }
            ]
          }
        }),
      })
    );

    expect(patchResponse.status).toBe(400);
    const result = await patchResponse.json();

    expect(result.error).toContain("failed to match");
    expect(result.filePath).toBe("initial.txt");
    expect(result.failedSearchBlock).toContain("This line is totally wrong");
    expect(result.proposedReplacement).toContain("Line after replacement.");
    expect(result.actualContextSnippet).toContain("Original codebase line.");

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

  it("should return parsed AST skeletons for requested target files in the workspace", async () => {
    const token = getActiveToken();

    // 1. Create a dummy TypeScript file to be parsed
    const tsFileContent = `
export function hello(name: string): string {
  console.log("doing details");
  return "hello " + name;
}
    `;
    await fs.writeFile(path.join(tempDir, "hello.ts"), tsFileContent);
    await execPromise("git add hello.ts", { cwd: tempDir });
    await execPromise("git commit -m 'commit hello.ts'", { cwd: tempDir });

    // 2. Initialize a Git transaction
    const initResponse = await app.handle(
      new Request("http://localhost/api/workspace/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({ taskId: "api-skeleton-test-id", cwd: tempDir }),
      })
    );

    expect(initResponse.status).toBe(200);
    const tx = await initResponse.json();

    // 3. Request skeletons for the created file
    const skeletonsResponse = await app.handle(
      new Request("http://localhost/api/workspace/skeletons", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          tx,
          paths: ["hello.ts"],
          cwd: tempDir,
        }),
      })
    );

    expect(skeletonsResponse.status).toBe(200);
    const result = await skeletonsResponse.json();
    
    expect(result.length).toBe(1);
    expect(result[0].filePath).toBe("hello.ts");
    
    // Assert method body was stripped down to {} and logic is hidden
    expect(result[0].content).toContain("export function hello(name: string): string {}");
    expect(result[0].content).not.toContain("doing details");

    // Clean up transaction
    await app.handle(
      new Request("http://localhost/api/workspace/abort", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({ tx, cwd: tempDir }),
      })
    );
  });
});

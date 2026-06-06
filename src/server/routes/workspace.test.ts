import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { app } from "../index";
import { getActiveToken } from "../middleware/security";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";

const execPromise = promisify(exec);

const mockGenerateStructuredObject = vi.fn();

vi.mock("../../lib/server/AiService.ts", () => {
  const { Context, Layer } = require("effect");
  const AiService = Context.GenericTag("AiService");
  const AiServiceLive = Layer.succeed(
    AiService,
    {
      generateStructuredObject: (...args: any[]) => mockGenerateStructuredObject(...args),
      streamText: () => { throw new Error("streamText not mocked"); }
    }
  );
  return {
    AiService,
    AiServiceLive,
  };
});

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
        body: JSON.stringify({ tx: tx, cwd: tempDir }),
      })
    );
  });

  it("should successfully execute task step and self-correct compile/test failures using mock Bun scripts", async () => {
    const token = getActiveToken();

    // 1. Setup mock bin directory and executable bun script
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    
    const mockBunScript = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "const isTsc = args.includes('tsc') || args.includes('x');",
      "const isTest = args.includes('test');",
      "",
      "if (isTsc) {",
      "  if (process.env.MOCK_TSC_FAIL === 'true') {",
      "    console.error('TS2322: Type mismatch error.');",
      "    process.exit(1);",
      "  }",
      "  process.exit(0);",
      "}",
      "",
      "if (isTest) {",
      "  if (process.env.MOCK_TEST_FAIL === 'true') {",
      "    console.error('Assertion failed: expected 42 to be 100');",
      "    process.exit(1);",
      "  }",
      "  process.exit(0);",
      "}",
      "",
      "process.exit(0);"
    ].join("\n");

    const bunPath = path.join(binDir, "bun");
    await fs.writeFile(bunPath, mockBunScript);
    await fs.chmod(bunPath, 0o755);

    // Stage and commit the mock bun script so the workspace remains clean for transaction init
    await execPromise("git add bin/bun", { cwd: tempDir });
    await execPromise("git commit -m 'add mock bun'", { cwd: tempDir });

    // Prep PATH to intercept bun calls
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;

    try {
      // 2. Initialize active Git Transaction
      const initResponse = await app.handle(
        new Request("http://localhost/api/workspace/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Grug-Token": token,
          },
          body: JSON.stringify({ taskId: "api-execute-step-id", cwd: tempDir }),
        })
      );
      expect(initResponse.status).toBe(200);
      const tx = await initResponse.json();

      // Configure mock states:
      // Turn 1: Typecheck fails. AI is queried.
      // Turn 2: Typecheck passes, test fails. AI is queried.
      // Turn 3: Both pass. Checkpoint is created.
      process.env.MOCK_TSC_FAIL = "true";
      process.env.MOCK_TEST_FAIL = "true";

      // Mock AI responses dynamically
      mockGenerateStructuredObject.mockImplementation((options: any) => {
        if (options.prompt.includes("compilation failed")) {
          process.env.MOCK_TSC_FAIL = "false";
          return Effect.succeed({
            summary: "Fix tsc",
            files: [
              {
                file_path: "initial.txt",
                code_diff: "<<<<<<< SEARCH\nInitial broken change.\n=======\nCode base edit 1.\n>>>>>>> REPLACE"
              }
            ]
          });
        }
        if (options.prompt.includes("test failures")) {
          process.env.MOCK_TEST_FAIL = "false";
          return Effect.succeed({
            summary: "Fix test",
            files: [
              {
                file_path: "initial.txt",
                code_diff: "<<<<<<< SEARCH\nCode base edit 1.\n=======\nCode base edit 2.\n>>>>>>> REPLACE"
              }
            ]
          });
        }
        return Effect.succeed({ files: [] });
      });

      // 3. Dispatch the /execute-step endpoint request
      const executeResponse = await app.handle(
        new Request("http://localhost/api/workspace/execute-step", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Grug-Token": token,
          },
          body: JSON.stringify({
            tx,
            targetFiles: ["initial.txt"],
            instructions: JSON.stringify({
              files: [
                {
                  file_path: "initial.txt",
                  code_diff: "<<<<<<< SEARCH\nOriginal codebase line.\n=======\nInitial broken change.\n>>>>>>> REPLACE"
                }
              ]
            }),
            cwd: tempDir
          })
        })
      );

      expect(executeResponse.status).toBe(200);
      const updatedTx = await executeResponse.json();
      expect(updatedTx.checkpoints.length).toBe(1);

      // Re-read file to verify final edits are written to disk
      const finalContent = await fs.readFile(path.join(tempDir, "initial.txt"), "utf-8");
      expect(finalContent).toBe("Code base edit 2.\n");

      // Clean up transaction
      await app.handle(
        new Request("http://localhost/api/workspace/abort", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Grug-Token": token,
          },
          body: JSON.stringify({ tx: updatedTx, cwd: tempDir }),
        })
      );
    } finally {
      process.env.PATH = originalPath;
      delete process.env.MOCK_TSC_FAIL;
      delete process.env.MOCK_TEST_FAIL;
    }
  });
});

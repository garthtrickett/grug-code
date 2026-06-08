import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { app } from "../index";
import { getActiveToken } from "../middleware/security";
import * as http from "node:http";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";

const originalFetch = globalThis.fetch;

const getUrlString = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if ("href" in input) {
    return input.href;
  }
  return input.url;
};

const safeStringifyBody = (body: unknown): string | Buffer => {
  if (typeof body === "string") {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body && typeof body === "object" && "toString" in body) {
    const str = (body as { toString(): string }).toString();
    if (str !== "[object Object]") {
      return str;
    }
  }
  return "";
};

const customFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit & { unix?: string }
): Promise<Response> => {
  if (init && init.unix) {
    const urlString = getUrlString(input);
    const url = new URL(urlString);
    return new Promise<Response>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: init.unix,
          path: url.pathname + url.search,
          method: init.method || "GET",
          headers: init.headers as Record<string, string>,
        },
        (res) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) {
              if (Array.isArray(value)) {
                for (const v of value) {
                  responseHeaders.append(key, v);
                }
              } else {
                responseHeaders.append(key, value);
              }
            }
          }

          const contentType = res.headers["content-type"] || "";
          const isEventStream = contentType.includes("text/event-stream");

          if (isEventStream) {
            const bodyStream = new ReadableStream<Uint8Array>({
              start(controller: ReadableStreamDefaultController) {
                res.on("data", (chunk: Uint8Array) => {
                  controller.enqueue(new Uint8Array(chunk));
                });
                res.on("end", () => {
                  controller.close();
                });
                res.on("error", (err) => {
                  controller.error(err);
                });
              },
              cancel() {
                res.destroy();
              },
            });

            const response = new Response(bodyStream as unknown as BodyInit, {
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: responseHeaders,
            });

            resolve(response);
            return;
          }

          const chunks: Uint8Array[] = [];
          res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            const response = new Response(body, {
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: responseHeaders,
            });

            Object.defineProperty(response, "body", {
              get() {
                return new ReadableStream<Uint8Array>({
                  start(controller: ReadableStreamDefaultController) {
                    controller.enqueue(new Uint8Array(body));
                    controller.close();
                  },
                });
              },
              configurable: true,
            });

            resolve(response);
          });
        }
      );
      req.on("error", (err) => {
        reject(err);
      });
      if (init.body) {
        req.write(safeStringifyBody(init.body));
      }
      req.end();
    });
  }
  return originalFetch(input, init);
};
import * as fs from "node:fs/promises";
import fsSync from "node:fs";
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

  beforeAll(() => {
    globalThis.fetch = Object.assign(customFetch, originalFetch);
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    tempDir = path.join(originalCwd, `.grug-api-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug API Test'", { cwd: tempDir });
    await execPromise("git config user.email 'api@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Original codebase line.\n");
    await fs.writeFile(path.join(tempDir, "main.ts"), "const x: number = 10;\nconsole.log(x);\n");
    await fs.writeFile(
      path.join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "es2022",
          moduleResolution: "node",
          skipLibCheck: true,
          noEmit: true
        },
        include: ["main.ts"]
      }, null, 2)
    );
    await execPromise("git add .", { cwd: tempDir });
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
        body: JSON.stringify({ taskId: "api-patch-task-id", provider: "openai" }),
      })
    );

    expect(initResponse.status).toBe(200);
    const tx = await initResponse.json() as any;
    expect(tx.ephemeralBranch).toBe("grug-task/api-patch-task-id");
    expect(tx.provider).toBe("openai");

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
    const patchResult = await patchResponse.json() as any;
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
    const result = await patchResponse.json() as any;

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
    const result = await skeletonsResponse.json() as any;
    
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
      const asyncRes = await executeResponse.json() as any;
      expect(asyncRes.status).toBe("running");
      expect(asyncRes.worktreePath).toBeDefined();
      expect(asyncRes.ephemeralBranch).toBe(tx.ephemeralBranch);

            // Poll until the background task is fully executed and the worktree is cleanly unlinked on success
      const worktreePath = asyncRes.worktreePath;
      let worktreeCreated = false;
      for (let i = 0; i < 40; i++) {
        const exists = await fs.stat(worktreePath).then(() => true).catch(() => false);
        if (exists) {
          worktreeCreated = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(worktreeCreated).toBe(true);

      let completed = false;
      for (let i = 0; i < 40; i++) {
        const exists = await fs.stat(worktreePath).then(() => true).catch(() => false);
        if (!exists) {
          completed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      expect(completed).toBe(true);

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
          body: JSON.stringify({ tx: asyncRes.tx, cwd: tempDir }),
        })
      );
    } finally {
      process.env.PATH = originalPath;
      delete process.env.MOCK_TSC_FAIL;
      delete process.env.MOCK_TEST_FAIL;
    }
  });

  test("should safely accept POST /research requests with mode 'discussion' and conversation history arrays", async () => {
    const token = getActiveToken();

    // Mock AI service to return discussion state when called
    mockGenerateStructuredObject.mockReturnValue(
      Effect.succeed({
        response: {
          status: "discussion",
          discussionText: "Grug has analyzed your codebase. Let's discuss Option A vs Option B.",
          suggestedOptions: ["Compare Option A and B", "Go straight to Option A"]
        }
      })
    );

    const response = await app.handle(
      new Request("http://localhost/api/workspace/research", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          userPrompt: "Analyze project layout",
          cwd: tempDir,
          provider: "openai",
          mode: "discussion",
          history: [
            { role: "user", text: "Please explore workspace" },
            { role: "assistant", text: "Grug studying project" }
          ]
        }),
      })
    );

    expect(response.status).toBe(200);
    const result = await response.json() as {
      status: string;
      discussionText: string;
      suggestedOptions: string[];
    };
    expect(result.status).toBe("discussion");
    expect(result.discussionText).toBe("Grug has analyzed your codebase. Let's discuss Option A vs Option B.");
    expect(result.suggestedOptions).toEqual(["Compare Option A and B", "Go straight to Option A"]);
  });

  it("should support verifying compilation/typecheck status programmatically via POST /verify", async () => {
    const token = getActiveToken();

    const initResponse = await app.handle(
      new Request("http://localhost/api/workspace/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({ taskId: "api-verify-task-id", cwd: tempDir }),
      })
    );
    expect(initResponse.status).toBe(200);
    const tx = await initResponse.json() as any;

    const verifyResponse = await app.handle(
      new Request("http://localhost/api/workspace/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          tx,
          type: "typecheck",
          cwd: tempDir,
        }),
      })
    );

    expect(verifyResponse.status).toBe(200);
    const verification = await verifyResponse.json() as any;
    expect(verification.success).toBe(true);
    expect(verification.dirtyFiles).toEqual([]);

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

  it("should return the authoritative active transaction state on GET /api/workspace/status", async () => {
    const token = getActiveToken();

    const statusBefore = await app.handle(
      new Request(`http://localhost/api/workspace/status?cwd=${encodeURIComponent(tempDir)}`, {
        method: "GET",
        headers: {
          "X-Grug-Token": token,
        },
      })
    );
    expect(statusBefore.status).toBe(200);
    const dataBefore = await statusBefore.json();
    expect(dataBefore).toBeNull();

    const dummyTasks = [
      { id: "task-status-check", description: "Verify active endpoint", targetFiles: ["initial.txt"], status: "pending" }
    ];

    const initResponse = await app.handle(
      new Request("http://localhost/api/workspace/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          taskId: "api-status-test",
          cwd: tempDir,
          provider: "gemini",
          tasks: dummyTasks
        }),
      })
    );

    expect(initResponse.status).toBe(200);
    const tx = await initResponse.json();

    const statusAfter = await app.handle(
      new Request(`http://localhost/api/workspace/status?cwd=${encodeURIComponent(tempDir)}`, {
        method: "GET",
        headers: {
          "X-Grug-Token": token,
        },
      })
    );
    expect(statusAfter.status).toBe(200);
    const dataAfter = await statusAfter.json() as any;

    expect(dataAfter).not.toBeNull();
    expect(dataAfter.tx.id).toBe("api-status-test");
    expect(dataAfter.tx.ephemeralBranch).toBe(tx.ephemeralBranch);
    expect(dataAfter.tasks.length).toBe(1);
    expect(dataAfter.tasks[0].id).toBe("task-status-check");

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

  it("should stream progress updates over UDS SSE cleanly as stream frames", async ({  }) => {
    const testSocketPath = path.resolve(`/tmp/grug-test-sse-${crypto.randomUUID()}.sock`);
    console.info("[Test:SSE] Starting test with socket path:", testSocketPath);
    
    // Prepare directory and clean up stale test socket files
    try {
      const dir = path.dirname(testSocketPath);
      if (!fsSync.existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
      }
      if (fsSync.existsSync(testSocketPath)) {
        await fs.unlink(testSocketPath);
      }
    } catch {}

    // Import udsApp dynamically
    const { udsApp } = await import("../index");
    
    // Temporarily override config's socketPath
    const { config } = await import("../../lib/server/Config");
    const originalSocketPath = config.surgical.socketPath;
    config.surgical.socketPath = testSocketPath;

    // Start UDS server
    console.info("[Test:SSE] Starting UDS server...");
    const serverUds = udsApp.listen({ unix: testSocketPath })
    expect(serverUds.server).toBeDefined();

    try {
      // Connect to UDS server SSE stream via Bun's UDS fetch support
      const token = getActiveToken();
      console.info("[Test:SSE] Sending fetch request to /api/workspace/stream-progress...");
      const response = await fetch("http://localhost/api/workspace/stream-progress", {
        unix: testSocketPath,
        headers: {
          "X-Grug-Token": token,
        }
      });

      console.info("[Test:SSE] Fetch completed. Status:", response.status, "Content-Type:", response.headers.get("Content-Type"));
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");

      console.info("[Test:SSE] Acquiring stream reader...");
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      if (reader) {
        // Emit a mock progress update
        const { progressBroadcaster } = await import("../../lib/server/WorkspaceController");
        
        console.info("[Test:SSE] Setting timeout to emit progress broadcast in 100ms...");
        setTimeout(() => {
          console.info("[Test:SSE] Emitting progress broadcast: Grug-SSE-Handshake-Success");
          progressBroadcaster.emit("progress", "Grug-SSE-Handshake-Success");
        }, 100);

        // Read from stream
        let streamClosed = false;
        let receivedText = "";
        
        console.info("[Test:SSE] Setting timeout of 3s to cancel stream reader if no data is received...");
        const timeoutId = setTimeout(() => {
          console.warn("[Test:SSE] Reader timeout reached! Canceling reader.");
          reader.cancel().catch(() => {});
        }, 3000);

        console.info("[Test:SSE] Starting stream read loop...");
        while (!streamClosed) {
          console.info("[Test:SSE] Awaiting reader.read()...");
          const { value, done } = await reader.read();
          if (done) {
            console.info("[Test:SSE] Reader returned done=true");
            streamClosed = true;
            break;
          }
          const chunk = new TextDecoder().decode(value);
          console.info("[Test:SSE] Chunk read from reader: " + chunk);
          receivedText += chunk;
          if (receivedText.includes("Grug-SSE-Handshake-Success")) {
            console.info("[Test:SSE] Success string found in stream text. Breaking read loop!");
            break;
          }
        }

        console.info("[Test:SSE] Canceling reader to close the active connection...");
        await reader.cancel();

        clearTimeout(timeoutId);
        expect(receivedText).toContain("data: Grug-SSE-Handshake-Success");
      }
    } finally {
      // Clean up server and restore original socket path config
      console.info("[Test:SSE] Teardown: Stopping UDS server...");
      await serverUds.stop();
      config.surgical.socketPath = originalSocketPath;
      try {
        if (fsSync.existsSync(testSocketPath)) {
          await fs.unlink(testSocketPath);
        }
      } catch {}
      console.info("[Test:SSE] Teardown complete.");
    }
  });

  it("should return immediate response containing task metadata on POST /execute-step", async () => {
    const token = getActiveToken();

    const initResponse = await app.handle(
      new Request("http://localhost/api/workspace/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({ taskId: "api-async-metadata-id", cwd: tempDir }),
      })
    );
    expect(initResponse.status).toBe(200);
    const tx = await initResponse.json() as any;

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
          instructions: "Modify files",
          cwd: tempDir
        })
      })
    );

    expect(executeResponse.status).toBe(200);
    const result = await executeResponse.json() as any;
    expect(result.status).toBe("running");
    expect(result.worktreePath).toBeDefined();
    expect(result.ephemeralBranch).toBe(tx.ephemeralBranch);
    expect(result.tx).toEqual(tx);

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

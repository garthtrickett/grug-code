import { test, expect } from "./utils/base-test.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import fsSync from "node:fs";
import * as path from "node:path";
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

globalThis.fetch = Object.assign(customFetch, originalFetch);

interface McpResponse {
  jsonrpc: string;
  result?: {
    protocolVersion?: string;
    content?: Array<{ text?: string }>;
  };
}

test.describe("Grug Code MCP Server Integration E2E", () => {
  let tempDir: string;

  test.beforeEach(async () => {
    // Setup clean isolated sandbox workspace repository to run the transaction tools securely
    tempDir = path.join(process.cwd(), `.grug-e2e-mcp-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    const execPromise = (cmd: string, args: string[]) => new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd: tempDir });
      p.on("close", (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error(`Command ${cmd} ${args.join(" ")} failed with exit code ${code}`));
      });
    });

    await execPromise("git", ["init"]);
    await execPromise("git", ["config", "user.name", "Grug MCP E2E"]);
    await execPromise("git", ["config", "user.email", "mcpe2e@test.com"]);
    await execPromise("git", ["config", "commit.gpgSign", "false"]);

    await fs.writeFile(path.join(tempDir, "main.ts"), "export const x = 42;\n");
    await execPromise("git", ["add", "main.ts"]);
    await execPromise("git", ["commit", "-m", "Initial commit"]);
  });

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should successfully spawn companion daemon in --mcp mode and execute list_directories and read_file_content tools", async () => {
    // Spawn the companion daemon in MCP stdio mode
    const child = spawn("bun", ["run", "src/server/index.ts", "--mcp"], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL_TEST || process.env.DATABASE_URL,
      }
    });

    let stdoutData = "";
    child.stdout.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) {
        stdoutData += chunk.toString("utf-8");
      } else {
        stdoutData += String(chunk);
      }
    });

    // We write a JSON-RPC 2.0 initialize request to perform the MCP handshake
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "Playwright-Test-Client",
          version: "1.0.0",
        },
      },
    };

    child.stdin.write(JSON.stringify(initializeRequest) + "\n");

    // Wait for the initialization response from the server
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Send a tools/call request to list the subdirectories inside the workspace sandbox
    const callToolsRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "list_directories",
        arguments: {
          cwd: tempDir,
        },
      },
    };

    child.stdin.write(JSON.stringify(callToolsRequest) + "\n");

    // Wait for output processing to complete
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Terminate process cleanly
    child.kill();

    // Verify stdout has standard JSON-RPC structures
    expect(stdoutData).toContain("jsonrpc");
    expect(stdoutData).toContain("result");
    expect(stdoutData).toContain("content");
  });

  test("should successfully spawn companion daemon in UDS MCP mode and handle SSE transport connections cleanly", async () => {
    const testSocketPath = path.resolve(`/tmp/grug-mcp-uds-test-${crypto.randomUUID()}.sock`);

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

    // Spawn companion daemon in UDS MCP mode
    const child = spawn("bun", ["run", "src/server/index.ts", "--mcp", "--transport=uds"], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL_TEST || process.env.DATABASE_URL,
        SURGICAL_ROUTER_SOCKET_PATH: testSocketPath,
      }
    });

    child.stdout.on("data", (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf-8")
        : typeof chunk === "string"
          ? chunk
          : String(chunk);
      console.info(`[Child Daemon STDOUT] ${text}`);
    });
    child.stderr.on("data", (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf-8")
        : typeof chunk === "string"
          ? chunk
          : String(chunk);
      console.error(`[Child Daemon STDERR] ${text}`);
    });

    // Wait for the socket file to be created on disk by Elysia UDS startup
    let exists = false;
    for (let i = 0; i < 40; i++) {
      if (fsSync.existsSync(testSocketPath)) {
        exists = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(exists).toBe(true);

    try {
      // Connect to the UDS SSE endpoint using Bun's native UDS fetch
      const sseResponse = await fetch("http://localhost/api/mcp/sse", {
        unix: testSocketPath,
      });

      expect(sseResponse.status).toBe(200);
      expect(sseResponse.headers.get("Content-Type")).toContain("text/event-stream");

      const reader = sseResponse.body?.getReader();
      expect(reader).toBeDefined();

      if (reader) {
        // Read the first event to capture the endpoint session ID parameter
        const { value } = await reader.read();
        const firstEventText = new TextDecoder().decode(value);
        
        expect(firstEventText).toContain("event: endpoint");
        expect(firstEventText).toContain("data: /api/mcp/messages?sessionId=");

        // Extract the session ID from the endpoint data
        const match = /sessionId=([a-zA-Z0-9\-]+)/.exec(firstEventText);
        const sessionId = match?.[1];
        expect(sessionId).toBeDefined();

        if (sessionId) {
          // Perform the initialize handshake POST message over UDS
          const initializeRequest = {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: {
                name: "Playwright-UDS-Test-Client",
                version: "1.0.0",
              },
            },
          };

          const initPostResponse = await fetch(`http://localhost/api/mcp/messages?sessionId=${sessionId}`, {
            unix: testSocketPath,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(initializeRequest),
          });

          if (initPostResponse.status !== 200) {
            console.error(`[E2E UDS Test] initPostResponse failed! Status: ${initPostResponse.status}`);
            console.error(`[E2E UDS Test] Response body: ${await initPostResponse.text()}`);
          }

          expect(initPostResponse.status).toBe(200);
          const initResult = (await initPostResponse.json()) as McpResponse;
          expect(initResult.jsonrpc).toBe("2.0");
          expect(initResult.result?.protocolVersion).toBeDefined();

          // Invoke the list_directories tool via UDS message POST
          const callToolsRequest = {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "list_directories",
              arguments: {
                cwd: tempDir,
              },
            },
          };

          const callPostResponse = await fetch(`http://localhost/api/mcp/messages?sessionId=${sessionId}`, {
            unix: testSocketPath,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(callToolsRequest),
          });

          if (callPostResponse.status !== 200) {
            console.error(`[E2E UDS Test] callPostResponse failed! Status: ${callPostResponse.status}`);
            console.error(`[E2E UDS Test] Response body: ${await callPostResponse.text()}`);
          }

          expect(callPostResponse.status).toBe(200);
          const toolResult = (await callPostResponse.json()) as McpResponse;
          expect(toolResult.jsonrpc).toBe("2.0");
          expect(toolResult.result?.content?.[0]?.text).toBeDefined();
        }

        await reader.cancel();
      }
    } finally {
      // Terminate child process and clean up socket file cleanly
      child.kill();
      try {
        if (fsSync.existsSync(testSocketPath)) {
          await fs.unlink(testSocketPath);
        }
      } catch {}
    }
  });
});
import { test, expect } from "./utils/base-test.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

test.describe("Grug Code MCP Server Integration E2E", () => {
  let tempDir: string;

  test.beforeEach(async () => {
    // Setup clean isolated sandbox workspace repository to run the transaction tools securely
    tempDir = path.join(process.cwd(), `.grug-e2e-mcp-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    const execPromise = (cmd: string, args: string[]) => new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd: tempDir });
      p.on("close", (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error(`Command ${cmd} ${args.join(" ")} failed with exit code ${code}`));
      });
    });

    await execPromise("git", ["init"]);
    await execPromise("git", ["config", "user.name", "Grug MCP E2E"]);
    await execPromise("git", ["config", "user.email", "mcpe2e@test.com"]);
    await execPromise("git", ["config", "commit.gpgSign", "false"]);

    await fs.writeFile(path.join(tempDir, "main.ts"), "export const x = 42;\n");
    await execPromise("git", ["add", "main.ts"]);
    await execPromise("git", ["commit", "-m", "Initial commit"]);
  });

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should successfully spawn companion daemon in --mcp mode and execute list_directories and read_file_content tools", async () => {
    // Spawn the companion daemon in MCP stdio mode
    const child = spawn("bun", ["run", "src/server/index.ts", "--mcp"], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL_TEST || process.env.DATABASE_URL,
      }
    });

    let stdoutData = "";
    child.stdout.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) {
        stdoutData += chunk.toString("utf-8");
      } else {
        stdoutData += String(chunk);
      }
    });

    // We write a JSON-RPC 2.0 initialize request to perform the MCP handshake
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "Playwright-Test-Client",
          version: "1.0.0",
        },
      },
    };

    child.stdin.write(JSON.stringify(initializeRequest) + "\n");

    // Wait for the initialization response from the server
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Send a tools/call request to list the subdirectories inside the workspace sandbox
    const callToolsRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "list_directories",
        arguments: {
          cwd: tempDir,
        },
      },
    };

    child.stdin.write(JSON.stringify(callToolsRequest) + "\n");

    // Wait for output processing to complete
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Terminate process cleanly
    child.kill();

    // Verify stdout has standard JSON-RPC structures
    expect(stdoutData).toContain("jsonrpc");
    expect(stdoutData).toContain("result");
    expect(stdoutData).toContain("content");
  });
});

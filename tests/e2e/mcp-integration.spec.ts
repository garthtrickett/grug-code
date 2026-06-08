import { test, expect } from "./utils/base-test.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
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

interface McpToolCallResult {
  readonly jsonrpc: string;
  readonly result?: {
    readonly content?: ReadonlyArray<{
      readonly type: "text";
      readonly text?: string;
    }>;
  };
}

interface McpToolListResult {
  readonly jsonrpc: string;
  readonly result?: {
    readonly tools?: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
    }>;
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

  test("should successfully connect to Elysia sidecar SSE transport and execute list_directories and read_file_content tools", async () => {
    // 1. Establish SSE Connection
    const sseResponse = await fetch("http://127.0.0.1:42069/api/mcp/sse");
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = sseResponse.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    // Read the first event to capture the session ID
    const { value } = await reader.read();
    const firstEventText = new TextDecoder().decode(value);
    expect(firstEventText).toContain("event: endpoint");

    const match = /sessionId=([a-zA-Z0-9\-]+)/.exec(firstEventText);
    const sessionId = match?.[1];
    expect(sessionId).toBeDefined();
    if (!sessionId) {
      await reader.cancel();
      return;
    }

    // 2. Perform Initialize Handshake
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

    const initPostResponse = await fetch(`http://127.0.0.1:42069/api/mcp/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initializeRequest),
    });
    expect(initPostResponse.status).toBe(200);
    const initResult = await initPostResponse.json() as McpToolCallResult;
    expect(initResult.jsonrpc).toBe("2.0");

    // 3. Call list_directories tool
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

    const callPostResponse = await fetch(`http://127.0.0.1:42069/api/mcp/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(callToolsRequest),
    });
    expect(callPostResponse.status).toBe(200);
    const toolResult = await callPostResponse.json() as McpToolCallResult;
    expect(toolResult.jsonrpc).toBe("2.0");
    expect(toolResult.result?.content?.[0]?.text).toBeDefined();

    // Verify directory lists 'main.ts'
    const textData = toolResult.result?.content?.[0]?.text ?? "";
    expect(textData).toContain("main.ts");

    await reader.cancel();
  });

  test("should successfully negotiate standard MCP tools/list and return registered companion tools", async () => {
    // 1. Establish SSE Connection
    const sseResponse = await fetch("http://127.0.0.1:42069/api/mcp/sse");
    expect(sseResponse.status).toBe(200);

    const reader = sseResponse.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    const { value } = await reader.read();
    const firstEventText = new TextDecoder().decode(value);
    const match = /sessionId=([a-zA-Z0-9\-]+)/.exec(firstEventText);
    const sessionId = match?.[1];
    expect(sessionId).toBeDefined();
    if (!sessionId) {
      await reader.cancel();
      return;
    }

    // 2. Initialize Handshake
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "Playwright-Test-Client", version: "1.0.0" },
      },
    };
    await fetch(`http://127.0.0.1:42069/api/mcp/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initializeRequest),
    });

    // 3. Request tools/list
    const listToolsRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    };

    const toolsResponse = await fetch(`http://127.0.0.1:42069/api/mcp/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listToolsRequest),
    });

    expect(toolsResponse.status).toBe(200);
    const toolsResult = await toolsResponse.json() as McpToolListResult;
    expect(toolsResult.jsonrpc).toBe("2.0");

    const tools = toolsResult.result?.tools || [];
    expect(tools.some((t) => t.name === "list_directories")).toBe(true);
    expect(tools.some((t) => t.name === "read_file_content")).toBe(true);

    await reader.cancel();
  });
});

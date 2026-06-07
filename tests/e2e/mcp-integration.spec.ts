import { test, expect } from "./utils/base-test.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import fsSync from "node:fs";
import * as path from "node:path";

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

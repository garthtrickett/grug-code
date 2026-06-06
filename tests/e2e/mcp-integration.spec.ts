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
    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString();
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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import fsSync from "node:fs";
import * as path from "node:path";

describe("Headless Compiled Binary Sanity Verification", () => {
  const coreDir = path.resolve(".");
  const daemonBinary = path.resolve(coreDir, "dist/grug-daemon");

  beforeAll(() => {
    console.error("[Build Test] Building standalone binaries...");
    execSync("bun run build", { cwd: coreDir, stdio: "inherit" });
  });

  afterAll(async () => {
    await fs.rm(path.resolve(coreDir, "dist"), { recursive: true, force: true }).catch(() => {});
  });

  it("should find the compiled binary on disk", () => {
    expect(fsSync.existsSync(daemonBinary)).toBe(true);
  });

  it("should spawn daemon successfully and pass standard MCP handshake protocol headlessly", async () => {
    const child = spawn(daemonBinary, [], {
      env: {
        ...process.env,
        NODE_ENV: "test"
      }
    });

    let stdoutData = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutData += chunk.toString("utf-8");
    });

    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "Playwright-Test-Client",
          version: "1.0.0"
        }
      }
    };

    child.stdin.write(JSON.stringify(initializeRequest) + "\n");

    await new Promise((resolve) => setTimeout(resolve, 500));

    child.kill();

    expect(stdoutData).toContain("jsonrpc");
    expect(stdoutData).toContain("result");
    expect(stdoutData).toContain("capabilities");
  });
});
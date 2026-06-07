import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { server } from "../src/daemon.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("Stdio MCP Daemon Tool Integration Tests", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeEach(async () => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    clientTransport = c;
    serverTransport = s;

    await server.connect(serverTransport);

    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  it("should successfully list registered tools and expose map_project and skeletal_research", async () => {
    const toolsResult = await client.listTools();
    const tools = toolsResult.tools;

    expect(tools.some((t) => t.name === "grug_map_project")).toBe(true);
    expect(tools.some((t) => t.name === "grug_skeletal_research")).toBe(true);
  });

  it("should execute grug_map_project correctly via InMemory client transport", async () => {
    const tempDir = path.join(process.cwd(), `.grug-mcp-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, "sanity.ts"), "const test = 1;\n");

    const result = await client.callTool("grug_map_project", { cwd: tempDir });
    expect(result.content[0].text).toContain("sanity.ts");

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});
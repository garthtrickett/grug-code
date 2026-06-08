import { describe, it, expect, afterEach } from "vitest";
import { createDaemonApp } from "../src/daemon.ts";

describe("Daemon MCP SSE Transport", () => {
  let appInstance: any = null;

  afterEach(async () => {
    if (appInstance) {
      await appInstance.stop();
      appInstance = null;
    }
  });

    it("should establish SSE transport, complete initialization handshake, and list registered tools", async () => {
    appInstance = createDaemonApp();
    await appInstance.listen({ port: 0, hostname: "127.0.0.1" });

    const port = appInstance.server?.port;
    expect(port).toBeGreaterThan(0);

    const sseResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/sse`);
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = sseResponse.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    const { value } = await reader.read();
    const rawText = new TextDecoder().decode(value);
    expect(rawText).toContain("event: endpoint");

    const sessionIdMatch = /sessionId=([a-zA-Z0-9\-]+)/.exec(rawText);
    const sessionId = sessionIdMatch?.[1];
    expect(sessionId).toBeDefined();
    if (!sessionId) {
      await reader.cancel();
      return;
    }

    const initRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "mcp-test-client",
          version: "1.0.0"
        }
      }
    };

        const initResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(initRequest)
    });

    expect(initResponse.status).toBe(200);
    const initResult = await initResponse.json() as any;
    expect(initResult.jsonrpc).toBe("2.0");
    expect(initResult.result?.protocolVersion).toBeDefined();

    const listToolsRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    };

        const toolsResponse = await fetch(`http://127.0.0.1:${port}/api/mcp/messages?sessionId=${sessionId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(listToolsRequest)
    });

    expect(toolsResponse.status).toBe(200);
    const toolsResult = await toolsResponse.json() as any;
    expect(toolsResult.jsonrpc).toBe("2.0");

    const tools = toolsResult.result?.tools || [];
    expect(tools.some((t: any) => t.name === "grug_map_project")).toBe(true);
    expect(tools.some((t: any) => t.name === "grug_skeletal_research")).toBe(true);

    await reader.cancel();
  });
});

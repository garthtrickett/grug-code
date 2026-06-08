import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

describe("Standalone Package Decoupling Sanity Check", () => {
  it("should load Effect execution runtime cleanly", () => {
    const program = Effect.succeed("grug-effect-runtime-active");
    const result = Effect.runSync(program);
    expect(result).toBe("grug-effect-runtime-active");
  });

  it("should validate types using Zod engine successfully", () => {
    const schema = z.object({
      daemonActive: z.boolean(),
      version: z.string(),
    });

    const parsed = schema.safeParse({
      daemonActive: true,
      version: "0.1.0",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.daemonActive).toBe(true);
    }
  });

  it("should instantiate MCP Server instance structurally without external network transports", () => {
    const server = new McpServer({
      name: "grug-test-daemon",
      version: "0.1.0",
    });
    expect(server).toBeDefined();
    expect(server.tool).toBeDefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import { McpService, McpServiceLive, McpLoggerLive } from "./McpServer.ts";

// Mock the connect function on server or the StdioServerTransport
const mockConnect = vi.fn().mockResolvedValue(undefined);
let passedServerInfo: any = null;

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  return {
    McpServer: class {
      constructor(public info: any) {
        passedServerInfo = info;
      }
      connect = mockConnect;
    }
  };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  return {
    StdioServerTransport: class {}
  };
});

describe("McpServer Unit Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    passedServerInfo = null;
  });

  it("should initialize the McpServer with correct naming parameters and connect successfully", async () => {
    const program = Effect.gen(function* () {
      const mcp = yield* McpService;
      yield* mcp.start();
    }).pipe(
      Effect.provide(McpServiceLive),
      Effect.provide(McpLoggerLive)
    );

    await Effect.runPromise(program);

    expect(passedServerInfo).toEqual({
      name: "grug-code-mcp",
      version: "0.1.0"
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});

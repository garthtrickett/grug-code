import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Context, Effect, Layer, Logger } from "effect";

export interface IMcpService {
  readonly start: () => Effect.Effect<void, Error>;
}

export class McpService extends Context.Tag("McpService")<
  McpService,
  IMcpService
>() {}

export const McpLoggerLive = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ logLevel, message }) => {
    console.error(`[${logLevel.label}] [McpServer] ${message}`);
  })
);

export const McpServiceLive = Layer.sync(
  McpService,
  () => {
    const server = new McpServer({
      name: "grug-code-mcp",
      version: "0.1.0",
    });

    const start = () =>
      Effect.gen(function* () {
        yield* Effect.logInfo("[McpService] Initializing MCP Server with Stdio transport...");
        const transport = new StdioServerTransport();
        
        yield* Effect.tryPromise({ 
          try: () => server.connect(transport),
          catch: (e) => new Error(`Failed to establish stdio connection for MCP server: ${String(e)}`),
        });

        yield* Effect.logInfo("[McpService] MCP Server stdio connection completed successfully.");
      });

    return { start };
  }
);

/**
 * Utility to globally redirect standard stdout (console.log) to stderr.
 * This prevents accidental library or third-party log statements from polluting
 * stdout, which would otherwise corrupt the stdio-based MCP JSON-RPC protocol stream.
 */
export const redirectConsoleLogToStderr = () => {
  console.log = (...args: unknown[]) => {
    console.error("[Redirected stdout]:", ...args);
  };
};

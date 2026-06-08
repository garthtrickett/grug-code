import { Context, Effect, Layer } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { clientLog } from "./clientLog.ts";

export interface McpContent {
  readonly type: string;
  readonly text?: string;
}

export interface McpCallToolResult {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
}

export interface IMcpClientService {
  readonly client: Client;
  readonly connect: () => Effect.Effect<void, Error>;
  readonly callTool: (
    name: string,
    args: Record<string, unknown>
  ) => Effect.Effect<McpCallToolResult, Error>;
}

export class McpClientService extends Context.Tag("app/McpClientService")<
  McpClientService,
  IMcpClientService
>() {}

export const McpClientLive = Layer.effect(
  McpClientService,
  Effect.gen(function* () {
    const client = new Client(
      { name: "grug-code-visual-client", version: "0.1.0" },
      { capabilities: {} }
    );

    let isConnected = false;

    const getSseUrl = (): URL => {
      const base = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:42069";
      if (base.startsWith("http")) {
        return new URL("/api/mcp/sse", base);
      }
      return new URL("/api/mcp/sse", window.location.origin);
    };

        const connect = () =>
      Effect.gen(function* () {
        if (isConnected) return;
        yield* clientLog("info", "[McpClientService] Connecting to sidecar daemon over SSE...");
        
        const sseUrl = getSseUrl();
        yield* clientLog("debug", `[McpClientService] Connection URL: ${sseUrl.toString()}`);
        
        const transport = new SSEClientTransport(sseUrl);

        yield* Effect.tryPromise({
          try: () => client.connect(transport),
          catch: (e) => new Error(`MCP Client SSE connection failed: ${String(e)}`),
        });

        isConnected = true;
        yield* clientLog("info", "[McpClientService] MCP Client connected and initialized.");
      });

                const callTool = (name: string, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        yield* connect();

        yield* clientLog("debug", `[McpClientService] Calling tool: ${name}`, args);

        const response = yield* Effect.tryPromise({
          try: () => client.callTool({ name, arguments: args }),
          catch: (e) => new Error(`Tool call '${name}' failed: ${String(e)}`),
        });

        yield* clientLog("debug", `[McpClientService] Tool '${name}' returned response:`, response);

        const res = response as unknown as McpCallToolResult;
        if (res.isError) {
          const firstContent = res.content[0];
          const errMsg = firstContent && firstContent.type === "text" ? (firstContent.text ?? "Unknown error") : "Unknown tool execution error";
          return yield* Effect.fail(new Error(errMsg));
        }

        return res;
      });

    return {
      client,
      connect,
      callTool,
    };
  })
);
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect, ManagedRuntime, Layer } from "effect";
import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { config } from "./lib/Config.ts";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { z } from "zod";
import { ProjectStructureMapper, ProjectStructureMapperLive } from "./features/ProjectStructureMapper.ts";
import { ResearchLoop, ResearchLoopLive } from "./features/ResearchLoop.ts";
import { AiServiceLive } from "./lib/AiService.ts";
import { TreeSitterParserLive } from "./lib/TreeSitterParser.ts";
import { SurgicalRouterLive } from "./features/SurgicalRouter.ts";
import { TokenEstimatorLive } from "./lib/TokenEstimator.ts";

// Prevent global stdout logging from corrupting standard JSON-RPC streams
console.info = (...args: unknown[]) => {
  console.error("[Redirected stdout]:", ...args);
};

const DaemonLive = SurgicalRouterLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectStructureMapperLive,
      ResearchLoopLive,
      AiServiceLive,
      TreeSitterParserLive,
      TokenEstimatorLive
    )
  )
);

const daemonRuntime = ManagedRuntime.make(DaemonLive);

/**
 * Creates and registers tools on a fresh McpServer instance.
 * Instantiating the server per-connection prevents active transport collisions
 * on concurrent HTTP/SSE client checkouts.
 */
export const createMcpServer = () => {
  const mcpServerInstance = new McpServer({
    name: "grug-code-mcp",
    version: "0.1.0",
  });

  mcpServerInstance.tool(
    "grug_map_project",
    "Recursively lists all files in the project workspace, ignoring standard dependency folders.",
    {
      cwd: z.string().optional().describe("Root directory path of the workspace to index")
    },
    async ({ cwd }) => {
      const effect = Effect.flatMap(ProjectStructureMapper, (mapper) =>
        mapper.mapProject({ cwd })
      );
      const result = await daemonRuntime.runPromise(Effect.either(effect));
      if (result._tag === "Left") {
        return {
          content: [{ type: "text", text: `Error: ${result.left.message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.right }],
      };
    }
  );

  mcpServerInstance.tool(
    "grug_skeletal_research",
    "Executes the Stage 1 skeletal pre-planning research loop to scan candidate signatures and build task checklists.",
    {
      userPrompt: z.string().describe("User prompt describing the desired code change or feature implementation"),
      projectStructure: z.string().describe("A JSON-encoded string array containing files representing active project mapping"),
      cwd: z.string().optional().describe("Root directory path of the active project workspace"),
      provider: z.enum(["gemini", "openai", "deepseek"]).optional().default("openai").describe("LLM provider to execute the planning loop"),
      mode: z.enum(["standard", "discussion"]).optional().default("standard").describe("Select standard autopilot planning or interactive advisory discussion mode"),
      history: z.array(
        z.object({
          role: z.enum(["user", "assistant"]),
          text: z.string()
        })
      ).optional().default([]).describe("Conversation Turn History array used in advisory discussion mode")
    },
    async ({ userPrompt, projectStructure, cwd, provider, mode, history }) => {
      const effect = Effect.flatMap(ResearchLoop, (loop) =>
        loop.run({
          userPrompt,
          projectStructure,
          cwd,
          provider,
          mode,
          history,
        })
      );
      const result = await daemonRuntime.runPromise(Effect.either(effect));
      if (result._tag === "Left") {
        return {
          content: [{ type: "text", text: `Error: ${result.left.message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.right) }],
      };
    }
  );

  return mcpServerInstance;
};

// Export the singleton for standard stdio mode and test backward-compatibility
export const server = createMcpServer();

export const mcpTransports = new Map<string, SSEServerTransport>();

class ElysiaMockResponse extends ServerResponse {
  private controller: ReadableStreamDefaultController<string>;

  constructor(controller: ReadableStreamDefaultController<string>) {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    super(req);
    this.controller = controller;
  }

  override writeHead(statusCode: number, ..._args: unknown[]): this {
    this.statusCode = statusCode;
    return this;
  }

  override write(chunk: unknown, ..._args: unknown[]): boolean {
    const text = typeof chunk === "string" 
      ? chunk 
      : chunk instanceof Uint8Array 
        ? new TextDecoder().decode(chunk) 
        : String(chunk);
    try {
      this.controller.enqueue(text);
    } catch {}
    return true;
  }

  override end(chunk?: unknown, ..._args: unknown[]): this {
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk);
    }
    try {
      this.controller.close();
    } catch {}
    this.emit("close");
    return this;
  }
}

export const createDaemonApp = () => {
  return new Elysia({
    serve: {
      reusePort: false
    }
  })
    .use(cors())
    .get("/api/health", () => ({ status: "ok", service: "grug-cli-daemon" }))
    .get("/api/preferences", () => ({ dailyReviewLimit: 20, dailyNewRuleLimit: 3, enforceMasteryGates: true }))
    .get("/api/auth/me", () => ({ user: { id: "daemon-user", email: "grug@daemon.local", permissions: ["platform:manage"] } }))
    .get("/api/mcp/sse", ({ set }) => {
      set.headers["Content-Type"] = "text/event-stream";
      set.headers["Cache-Control"] = "no-cache";
      set.headers["Connection"] = "keep-alive";

      let activeTransport: SSEServerTransport | null = null;

      const stream = new ReadableStream({
        async start(controller) {
          const mockRes = new ElysiaMockResponse(controller as ReadableStreamDefaultController<string>);
          const transport = new SSEServerTransport("/api/mcp/messages", mockRes);
          mcpTransports.set(transport.sessionId, transport);
          activeTransport = transport;

          // Instantiate a fresh McpServer per SSE session to support multiple simultaneous connections
          const mcpServerInstance = createMcpServer();
          await mcpServerInstance.connect(transport);
        },
        cancel() {
          if (activeTransport) {
            try {
              mcpTransports.delete(activeTransport.sessionId);
              void activeTransport.close();
            } catch {}
          }
        }
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    })
    .post("/api/mcp/messages", async ({ query, body, set }) => {
      const sessionId = query.sessionId;
      if (!sessionId) {
        set.status = 400;
        return { error: "Missing sessionId" };
      }

      const transport = mcpTransports.get(sessionId);
      if (!transport) {
        set.status = 404;
        return { error: "Session not found" };
      }

      let responseBody = "";
      let statusCode = 200;
      const mockRes = {
        writeHead(code: number) {
          statusCode = code;
          return this;
        },
        end(chunk?: unknown) {
          if (typeof chunk === "string") {
            responseBody = chunk;
          } else if (chunk instanceof Buffer) {
            responseBody = chunk.toString("utf-8");
          }
          return this;
        }
      } as unknown as ServerResponse;

      const mockReq = {
        headers: {
          "content-type": "application/json",
        },
      } as unknown as IncomingMessage;

      let lastSentMessage: unknown = null;
      let resolveMessage: ((msg: unknown) => void) | null = null;
      const messagePromise = new Promise<unknown>((resolve) => {
        resolveMessage = resolve;
      });

      const originalSend = transport.send ? transport.send.bind(transport) : undefined;
      if (originalSend) {
        transport.send = async (message: unknown) => {
          lastSentMessage = message;
          if (resolveMessage) {
            resolveMessage(message);
          }
          return originalSend(message as Parameters<SSEServerTransport['send']>[0]);
        };
      }
      
      try {
        await transport.handlePostMessage(mockReq, mockRes, body);
        
        // Dynamically scale timeout depending on whether it is a JSON-RPC request (has "id") or notification
        const hasId = body && typeof body === "object" && "id" in body;
        const timeoutDuration = hasId ? 120000 : 50;

        if (!lastSentMessage) {
          await Promise.race([
            messagePromise,
            new Promise((resolve) => setTimeout(resolve, timeoutDuration))
          ]);
        }
      } catch (err) {
        if (originalSend) {
          transport.send = originalSend;
        }
        set.status = 500;
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (originalSend) {
          transport.send = originalSend;
        }
      }

      if (lastSentMessage) {
        set.status = 200;
        return lastSentMessage;
      }

      set.status = statusCode === 202 ? 200 : statusCode;
      if (responseBody) {
        try {
          return JSON.parse(responseBody) as unknown;
        } catch {
          return responseBody;
        }
      }
      return "";
    }, {
      query: t.Object({
        sessionId: t.String()
      })
    });
};

if (import.meta.main) {
  const useStdio = process.argv.includes("--stdio") || process.env.DAEMON_STDIO === "true";
  if (useStdio) {
    const transport = new StdioServerTransport();
    server.connect(transport).then(() => {
      console.error("[Daemon] Stdio server connected successfully.");
    }).catch((err) => {
      console.error("[Daemon] Stdio server failed:", err);
    });
  } else {
        const port = process.env.DAEMON_PORT ? parseInt(process.env.DAEMON_PORT, 10) : config.network.daemonPort;
    const app = createDaemonApp();
    app.listen({ port, hostname: "127.0.0.1" });
    console.error(`[Daemon] Elysia server is running at http://127.0.0.1:${port}`);
  }
}

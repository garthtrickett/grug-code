// Disable JIT compilation at the absolute process entry point to prevent SIGTRAP debugger freezes on NixOS
process.env.BUN_JIT = "0";
process.env.JSC_useJIT = "false";

import { Elysia, Context, t } from "elysia";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";

// Ensure the dist/assets directory exists so @elysiajs/static doesn't crash on startup during development
if (!existsSync("./dist/assets")) {
  mkdirSync("./dist/assets", { recursive: true });
}
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import { effectPlugin } from "./middleware/effect-plugin";
import { authRoutes } from "./routes/auth.ts";
import { workspaceRoutes } from "./routes/workspace.ts";
import { projectRoutes } from "./routes/projects.ts";
import { getActiveToken } from "./middleware/security.ts";

import { McpService, McpServiceLive, McpLoggerLive, redirectConsoleLogToStderr, mcpTransports as baseTransports } from "../lib/server/mcp/McpServer.ts";
import { Effect } from "effect";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

// Safe global-gated singleton to prevent duplicate Map instances across hot-reloads/bundling splits
const globalForMcp = globalThis as unknown as {
  mcpTransports?: Map<string, SSEServerTransport>;
};

export const mcpTransports = globalForMcp.mcpTransports ?? baseTransports;

if (process.env.NODE_ENV !== "production") {
  globalForMcp.mcpTransports = mcpTransports;
}

export class ElysiaMockResponse extends ServerResponse {
  private controller: ReadableStreamDefaultController<Uint8Array>;

  constructor(controller: ReadableStreamDefaultController<Uint8Array>) {
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
      const encoder = new TextEncoder();
      this.controller.enqueue(encoder.encode(text));
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

export const mcpRoutes = new Elysia({ prefix: "/api/mcp" })
  .get("/sse", ({ set }) => {
    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";
    set.headers["X-Accel-Buffering"] = "no"; // Prevent connection buffering under proxy networks

    let activeTransport: SSEServerTransport | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const mockRes = new ElysiaMockResponse(controller);
        const transport = new SSEServerTransport("/api/mcp/messages", mockRes);
        
        console.error(`[McpServer] 🟢 New SSE connection established. SessionId: "${transport.sessionId}"`);
        
        // Setup a safe thread-safe request registry directly on the transport instance
        const pendingRequests = new Map<string, (msg: unknown) => void>();
        (transport as any)._pendingRequests = pendingRequests;

        const originalSend = transport.send.bind(transport);
        transport.send = async (message: any) => {
          if (message && typeof message === "object" && "id" in message) {
            const reqId = String(message.id);
            const resolver = pendingRequests.get(reqId);
            if (resolver) {
              resolver(message);
              pendingRequests.delete(reqId);
            }
          }
          return originalSend(message);
        };

        mcpTransports.set(transport.sessionId, transport);
        activeTransport = transport;

        // Instantiate a fresh McpServer per SSE session to support multiple simultaneous connections
        const { createMcpServer } = await import("../lib/server/mcp/McpServer.ts");
        const mcpServerInstance = createMcpServer();
        await mcpServerInstance.connect(transport);
      },
      cancel() {
        if (activeTransport) {
          console.error(`[McpServer] 🔴 SSE stream cancelled/closed prematurely for SessionId: "${activeTransport.sessionId}"`);
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
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Pragma": "no-cache"
      }
    });
  })
  .post("/messages", async ({ query, body, set }) => {
    const sessionId = query.sessionId;
    console.error(`[McpServer] 📩 Received POST to /messages with sessionId: "${sessionId}"`);
    
    if (!sessionId) {
      set.status = 400;
      return { error: "Missing sessionId" };
    }

    const transport = mcpTransports.get(sessionId);
    if (!transport) {
      console.error(`[McpServer] ❌ Session not found for sessionId: "${sessionId}". Active sessions:`, Array.from(mcpTransports.keys()));
      set.status = 404;
      return { error: "Session not found" };
    }

    const hasId = body && typeof body === "object" && "id" in body;
    const reqId = hasId ? String((body as any).id) : null;

    let resolveMessage: ((msg: unknown) => void) | null = null;
    let messagePromise: Promise<unknown> | null = null;

    if (reqId) {
      messagePromise = new Promise<unknown>((resolve) => {
        resolveMessage = resolve;
      });
      const pendingMap = (transport as any)._pendingRequests;
      if (pendingMap) {
        pendingMap.set(reqId, resolveMessage);
      }
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

    try {
      await transport.handlePostMessage(mockReq, mockRes, body);
      
      if (messagePromise) {
        const timeoutDuration = 120000;
        const responseMessage = await Promise.race([
          messagePromise,
          new Promise((resolve) => setTimeout(resolve, timeoutDuration))
        ]);

        if (responseMessage) {
          set.status = 200;
          return responseMessage;
        }
      }
    } catch (err) {
      console.error(`[McpServer] ❌ Error in handlePostMessage:`, err);
      const pendingMap = (transport as any)._pendingRequests;
      if (pendingMap && reqId) {
        pendingMap.delete(reqId);
      }
      set.status = 500;
      return { error: err instanceof Error ? err.message : String(err) };
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

const isMcpMode = 
  (typeof Bun !== "undefined" && Bun.argv && Bun.argv.includes("--mcp")) || 
  (typeof process !== "undefined" && process.argv && process.argv.includes("--mcp"));

const isUdsMcp = 
  (typeof Bun !== "undefined" && Bun.argv && Bun.argv.includes("--transport=uds")) || 
  (typeof process !== "undefined" && process.argv && process.argv.includes("--transport=uds"));

if (isMcpMode) {
  redirectConsoleLogToStderr();
  const program = Effect.gen(function* () {
    const mcp = yield* McpService;
    yield* mcp.start();
  }).pipe(
    Effect.provide(McpServiceLive),
    Effect.provide(McpLoggerLive)
  );

  void import("../lib/server/server-runtime.ts").then(({ serverRuntime }) => {
    void serverRuntime.runPromise(program).catch((err) => {
      console.error("[McpServer] Catastrophic startup failure:", err);
      process.exit(1);
    });
  });
}

// Proactively pre-warm lazy server layers (Tree-Sitter and WASM modules) in the background on startup
void import("../lib/server/TreeSitterParser.ts").then(({ TreeSitterParser, TreeSitterParserLive }) => {
  void import("../lib/server/server-runtime.ts").then(({ serverRuntime }) => {
    const prewarm = Effect.serviceOption(TreeSitterParser).pipe(
      Effect.provide(TreeSitterParserLive),
      Effect.catchAll(() => Effect.void)
    );
    serverRuntime.runPromise(prewarm).then(() => {
      console.error("[McpServer] ⚡ Pre-warmed lazy TreeSitter parser WASM engine cleanly on startup.");
    }).catch((err) => {
      console.error("[McpServer] ⚠️ Failed to pre-warm TreeSitter parser:", err);
    });
  });
});

export const app = new Elysia({
  serve: {
    idleTimeout: 255, 
  }
})
  .onBeforeHandle(({ request, set }) => {
    if (request.url.includes("/api/")) {
      set.headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
      set.headers["Pragma"] = "no-cache";
      set.headers["Expires"] = "0";
    }
  })
  .onError(({ code, error, request }) => {
    console.error(`❌ [Global Error] ${String(request.method)} ${String(request.url)} - ${String(code)}:`, error);
  })
  .onRequest(({ request }) => {
    console.error(`📡 [HTTP Request Started] ${String(request.method)} ${String(request.url)}`);
  })
  .onAfterResponse(({ request, set }) => {
    console.error(`✅ [HTTP Response Finished] ${String(request.method)} ${String(request.url)} -> Status ${set.status}`);
  })
  .get("/api/health", () => {
    console.error("📡 [API Health GET] Responding with 200 OK");
    return { status: "ok", service: "grug-cli-daemon" };
  })
  .head("/api/health", () => {
    console.error("📡 [API Health HEAD] Responding with 200 OK");
    return new Response(null, { status: 200 });
  })
  .use(cors({
    origin: [
      /localhost.*/,
      /127\.0\.0\.1.*/, // Corrected CORS loopback IP regex pattern
      /.*\.life-io\.xyz/,
      "https://life-io.xyz",
      "capacitor://localhost",
      "tauri://localhost",
      "tauri.localhost",
      "http://localhost",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Life-IO-Subdomain", "Cache-Control", "Pragma", "Expires", "X-Grug-Token"],
    credentials: true,
  }))
  .use(effectPlugin)
  .post("/api/log", async ({ body, runEffect }) => {
    const logPayload = body as {
      level: string;
      message: string;
      data: unknown;
      url: string;
      timestamp?: string;
    };
    const { level, message, data, url, timestamp } = logPayload;
    const clientTimestamp = timestamp || new Date().toISOString();
    const formattedData = data && (typeof data === "object" && Object.keys(data).length > 0) ? ` | Data: ${JSON.stringify(data)}` : "";
    const logMsg = `📱 [Client] [${clientTimestamp}] ${message}${formattedData} (URL: ${url})`;

    const logEffect = (() => {
      switch (level?.toLowerCase()) {
        case "error":
          return Effect.logError(logMsg);
        case "warn":
        case "warning":
          return Effect.logWarning(logMsg);
        case "debug":
          return Effect.logDebug(logMsg);
        case "info":
        default:
          return Effect.logInfo(logMsg);
      }
    })();

    await runEffect(logEffect);
    return { success: true };
  })
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(projectRoutes)
  .use(mcpRoutes)
  .use(
    staticPlugin({
      assets: "./dist/assets",
      prefix: "/assets",
    })
  )
  .get("/manifest.webmanifest", () => Bun.file("./dist/manifest.webmanifest"))
  .get("/sw.js", () => Bun.file("./dist/sw.js"))
  .get("/favicon.ico", () => Bun.file("./dist/favicon.ico"))
  .get("/icon-192.png", () => Bun.file("./dist/icon-192.png"))
  .get("/icon-512.png", () => Bun.file("./dist/icon-512.png"))
  .get("/apple-touch-icon.png", () => Bun.file("./dist/apple-touch-icon.png"))
  .get("*", async ({ set }: Context) => {
    set.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, proxy-revalidate";
    set.headers["Pragma"] = "no-cache";
    set.headers["Expires"] = "0";
    if (existsSync("./dist/index.html")) {
      const html = await Bun.file("./dist/index.html").text();
      const token = getActiveToken();
      const metaTag = `<meta name="grug-session-token" content="${token}">`;
      const injectedHtml = html.replace("<head>", `<head>\n    ${metaTag}`);
      set.headers["Content-Type"] = "text/html; charset=utf-8";
      return injectedHtml;
    }
    return "Development Server: Build output is not present in `./dist`. Use the Vite dev server on port 3000.";
  });

const shouldRunServers = 
  !process.env.VITEST && 
  (!isMcpMode || isUdsMcp);

if (shouldRunServers) {
  if (isUdsMcp) {
    const socketPath = process.env.SURGICAL_ROUTER_SOCKET_PATH || "/tmp/grug-mcp.sock";
    try {
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }
    } catch {}
    app.listen({ unix: socketPath });
    console.info(`🦊 Elysia is running on UDS socket at ${socketPath}`);
  } else {
    const port = process.env.BACKEND_PORT ? parseInt(process.env.BACKEND_PORT) : 42069;
    app.listen({ port, hostname: "127.0.0.1" });
    console.info(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
  }
}

export type App = typeof app;
export const udsApp = app;

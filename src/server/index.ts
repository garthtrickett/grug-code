import { Elysia, Context, t } from "elysia";
import { existsSync, mkdirSync } from "node:fs";

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

import { McpService, McpServiceLive, McpLoggerLive, redirectConsoleLogToStderr } from "../lib/server/mcp/McpServer.ts";
import { Effect } from "effect";
import { config } from "../lib/server/Config";
import * as path from "node:path";
import * as fs from "node:fs";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

export const mcpTransports = new Map<string, SSEServerTransport>();

export class ElysiaMockResponse extends ServerResponse {
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

export const mcpRoutes = new Elysia({ prefix: "/api/mcp" })
  .get("/sse", ({ set }) => {
    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";

    const stream = new ReadableStream({
      async start(controller) {
        const mockRes = new ElysiaMockResponse(controller as ReadableStreamDefaultController<string>);
        const transport = new SSEServerTransport("/api/mcp/messages", mockRes);
        
        mcpTransports.set(transport.sessionId, transport);
        (controller as unknown as { _transport: SSEServerTransport })._transport = transport;

        const { mcpServer } = await import("../lib/server/mcp/McpServer.ts");
        await mcpServer.connect(transport);
      },
      cancel(controller) {
        const transport = (controller as unknown as { _transport?: SSEServerTransport })._transport;
        if (transport) {
          try {
            mcpTransports.delete(transport.sessionId);
            void transport.close();
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
  .post("/messages", async ({ query, body, set }) => {
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

    const mockReq = {} as unknown as IncomingMessage;
    await transport.handlePostMessage(mockReq, mockRes, body);

    set.status = statusCode;
    if (responseBody) {
      return JSON.parse(responseBody) as unknown;
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

export const app = new Elysia({
  serve: {
    idleTimeout: 255, // Set Bun/Elysia idle timeout to maximum to prevent dropped connections on slow LLM calls
  }
})
  .onError(({ code, error, request }) => {
    console.error(`[Global Error] ${String(request.method)} ${String(request.url)} - ${String(code)}`, error);
  })
  .onRequest(({ request }) => {
    console.info(`📡 [HTTP] ${String(request.method)} ${String(request.url)}`);
  })
  .use(cors({
    origin: [
      /localhost.*/,
      /127\.0\.0\.1.*/,
      /.*\.life-io\.xyz/,
      "https://life-io.xyz",
      "capacitor://localhost",
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

export const udsApp = new Elysia({
  serve: {
    unix: config.surgical.socketPath,
  }
})
  .onError(({ code, error, request }) => {
    console.error(`[UDS Global Error] ${String(request.method)} ${String(request.url)} - ${String(code)}`, error);
  })
  .onRequest(({ request }) => {
    console.info(`📡 [UDS HTTP] ${String(request.method)} ${String(request.url)}`);
  })
  .use(effectPlugin)
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(projectRoutes)
  .use(mcpRoutes);

const originalUdsStop = udsApp.stop.bind(udsApp);
udsApp.stop = async () => {
  await originalUdsStop();
  try {
    const socketPath = config.surgical.socketPath;
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
      console.info(`🧹 [UDS Shutdown] Cleaned up Unix socket file: ${String(socketPath)}`);
    }
  } catch (err) {
    console.error(`⚠️ [UDS Shutdown] Failed to cleanup Unix socket file: ${String(err)}`);
  }
  return udsApp;
};

const shouldRunServers = 
  process.env.NODE_ENV !== "test" && 
  !process.env.VITEST && 
  (!isMcpMode || isUdsMcp);

if (shouldRunServers) {
  const port = process.env.BACKEND_PORT ? parseInt(process.env.BACKEND_PORT) : 42069;
  app.listen(port);
  console.info(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);

  const socketPath = config.surgical.socketPath;
  try {
    const dir = path.dirname(socketPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch (err) {
    console.warn(`[UDS Startup] Failed to prepare socket path directory or unlink stale socket: ${String(err)}`);
  }

  udsApp.listen({ unix: config.surgical.socketPath });
  console.info(`🔌 [UDS Server] Unix Domain Socket server is listening at ${String(socketPath)}`);

  const cleanupSocket = () => {
    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
        console.info(`🧹 [Shutdown] Cleaned up Unix socket: ${String(socketPath)}`);
      }
    } catch (err) {
      console.error(`⚠️ [Shutdown] Failed to cleanup Unix socket: ${String(err)}`);
    }
  };

  process.on("SIGINT", () => {
    cleanupSocket();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanupSocket();
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    console.error("🔥 [UDS Fatal] Uncaught Exception caught on process:", err);
    cleanupSocket();
    process.exit(1);
  });

  process.on("exit", () => {
    cleanupSocket();
  });
}

export type App = typeof app;

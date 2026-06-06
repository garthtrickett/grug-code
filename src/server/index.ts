import { Elysia, Context } from "elysia";
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
import { getActiveToken } from "./middleware/security.ts";

import { McpService, McpServiceLive, McpLoggerLive, redirectConsoleLogToStderr } from "../lib/server/mcp/McpServer.ts";
import { Effect } from "effect";

const isMcpMode = 
  (typeof Bun !== "undefined" && Bun.argv && Bun.argv.includes("--mcp")) || 
  (typeof process !== "undefined" && process.argv && process.argv.includes("--mcp"));

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

export const app = new Elysia()
  .onError(({ code, error, request }) => {
    console.error(`[Global Error] ${request.method} ${request.url} - ${code}`, error);
  })
  .onRequest(({ request }) => {
    console.info(`📡 [HTTP] ${request.method} ${request.url}`);
  })
    .post("/api/log", ({ body }) => {
    const logPayload = body as {
      level: string;
      message: string;
      data: Record<string, unknown> | null | undefined;
      url: string;
    };
    const level = logPayload.level;
    const message = logPayload.message;
    const data = logPayload.data;
    const url = logPayload.url;
    const formattedData = data && Object.keys(data).length ? JSON.stringify(data, null, 2) : "";
    console.info(`📱 [Client ${level.toUpperCase()}] ${message} ${formattedData} (URL: ${url})`);
    return { success: true };
  })
  .use(authRoutes)
  .use(workspaceRoutes)
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
    allowedHeaders: ["Content-Type", "Authorization", "X-Life-IO-Subdomain", "Cache-Control", "Pragma", "Expires"],
    credentials: true,
  }))
  .use(effectPlugin)
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

if (process.env.NODE_ENV !== "test" && !isMcpMode) {
  const port = process.env.BACKEND_PORT ? parseInt(process.env.BACKEND_PORT) : 42069;
  app.listen(port);
  console.info(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
}

export type App = typeof app;

import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

function injectGrugTokenPlugin() {
  return {
    name: "inject-grug-token",
    transformIndexHtml(html: string) {
      try {
        const sessionPath = path.resolve(process.cwd(), ".grug-session.json");
        let token = "";

        if (fs.existsSync(sessionPath)) {
          const fileContent = fs.readFileSync(sessionPath, "utf-8");
          const data = JSON.parse(fileContent) as { token?: string };
          if (data && typeof data === "object" && typeof data.token === "string") {
            token = data.token;
          }
        }

        // If no token exists on disk yet, initialize it early to prevent race conditions
        if (!token) {
          token = crypto.randomUUID();
          fs.writeFileSync(sessionPath, JSON.stringify({ token }, null, 2), "utf-8");
          console.log("[Vite Plugin] Generated fresh session token:", token);
        }

        const metaTag = `<meta name="grug-session-token" content="${token}">`;
        return html.replace("<head>", `<head>\n    ${metaTag}`);
      } catch (e) {
        console.warn("[Vite Plugin] Failed to inject grug session token", e);
      }
      return html;
    }
  };
}

export default defineConfig(({ command, mode }) => ({
  base: "/",
  plugins: [
    injectGrugTokenPlugin(),
    tailwindcss(),
  ],
  server: {
    watch: {
      ignored: ["**/.grug-e2e-temp-*/**"]
    },
    host: true,
    port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
    allowedHosts: true,
    hmr: {
      clientPort: process.env.VITE_HMR_SECURE === "true" ? 443 : undefined,
    },
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.BACKEND_PORT || "42069"}`,
        changeOrigin: true,
        timeout: 120000, // 2-minute request timeout limit
        proxyTimeout: 120000, // 2-minute connection timeout limit
      },
      "/ws": {
        target: `ws://127.0.0.1:${process.env.BACKEND_PORT || "42069"}`,
        ws: true,
        changeOrigin: true,
        timeout: 120000,
        proxyTimeout: 120000,
      }
    }
  }
}));

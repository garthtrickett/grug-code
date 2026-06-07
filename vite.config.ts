import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import * as fs from "node:fs";
import * as path from "node:path";

function injectGrugTokenPlugin() {
  return {
    name: "inject-grug-token",
    transformIndexHtml(html: string) {
      try {
        const sessionPath = path.resolve(process.cwd(), ".grug-session.json");
        if (fs.existsSync(sessionPath)) {
          const fileContent = fs.readFileSync(sessionPath, "utf-8");
          const data = JSON.parse(fileContent) as { token?: string };
          if (data && typeof data === "object" && typeof data.token === "string") {
            const token = data.token;
            const metaTag = `<meta name="grug-session-token" content="${token}">`;
            return html.replace("<head>", `<head>\n    ${metaTag}`);
          }
        }
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
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      injectManifest: {
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024, // High threshold to support pre-cached audio assets
      },
      filename: "sw.ts",
      registerType: "prompt",
      devOptions: {
        enabled: false,
        type: "module",
      },
      manifest: {
        name: "Grug Code",
        short_name: "GC",
        description: "Coding Agent",
        start_url: "/",
        display: "standalone",
        background_color: "#09090b",
        theme_color: "#09090b",
        orientation: "portrait-primary",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable"
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ],
        screenshots: [
          {
            src: "/screenshot-mobile.png",
            sizes: "512x512",
            type: "image/png",
            label: "Review Interface"
          },
          {
            src: "/screenshot-desktop.png",
            sizes: "512x512",
            type: "image/png",
            form_factor: "wide",
            label: "Curator Dashboard"
          }
        ]
      }
    })
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

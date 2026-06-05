import { esbuildPlugin } from "@web/dev-server-esbuild";
import proxy from "koa-proxies";
import { config } from "dotenv";

config();

export default {
  files: "tests/e2e/smoke.spec.ts",
  concurrency: 1,
  testsFinishTimeout: 60000, 

  nodeResolve: {
    exportConditions: ["browser", "development"],
  },
  middleware: [
    proxy("/api", {
      target: "http://127.0.0.1:42069",
      changeOrigin: true,
    }),
    proxy("/ws", {
      target: "ws://127.0.0.1:42069",
      ws: true,
      changeOrigin: true,
    }),
  ],
  coverageConfig: {
    report: true,
    reportDir: 'coverage',
    threshold: { statements: 0, branches: 0, functions: 0, lines: 0 }
  },
  browserLogs: true,
  plugins: [
    {
      name: "env-injection",
      transform(context) {
        if (context.response.is("html")) {
          return {
            body: context.body.replace(
              "<head>",
              '<head><script>window.process = { env: { NODE_ENV: "development" } };</script>'
            ),
          };
        }
      },
    },
    esbuildPlugin({
      ts: true,
      target: "es2022",
      tsconfig: "./tsconfig.json",
      define: {
        "import.meta.env.VITE_API_BASE_URL": JSON.stringify(process.env.VITE_API_BASE_URL || "http://127.0.0.1:42069"),
        "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL || "ws://127.0.0.1:42069"),
        "import.meta.env.DEV": "true",
        "import.meta.env.PROD": "false",
        "import.meta.env.SSR": "false",
      },
    }),
    {
      name: "css-mock",
      serve(context) {
        if (context.path.endsWith(".css")) {
          return {
            body: "export default new Proxy({}, { get: (_, prop) => prop });",
            type: "js",
          };
        }
      },
    }
  ],
  testFramework: {
    config: {
      timeout: 20000, 
    },
  },
};

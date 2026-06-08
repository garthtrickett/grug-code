import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, ".env") });

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/e2e-global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 1,
  reporter: "list",
  timeout: 60000, 
  
    use: {
    baseURL: "http://127.0.0.1:42069",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
    ignoreHTTPSErrors: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    }
  },

  projects: [
    {
      name: "chromium",
      use: { 
        ...devices["Desktop Chrome"],
        channel: undefined 
      },
    },
  ],

    webServer: {
    command: "./dist/grug-daemon",
    url: "http://127.0.0.1:42069/api/health",
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120 * 1000,
    ignoreHTTPSErrors: true,
    env: {
      BACKEND_PORT: "42069",
      VITE_SILENT_CLIENT_LOGGING: "true",
      SURGICAL_ROUTER_FILE_LIMIT: "3",
      SURGICAL_ROUTER_TOKEN_LIMIT: "20000",
      DATABASE_URL: process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || ""
    }
  },
});

import { test as base } from "@playwright/test";

const attachLogs = (page: import("@playwright/test").Page, name: string) => {
  page.on("console", (msg) => {
    if (!msg.text().includes("[vite]")) {
      console.log(`[Browser: ${name}] ${msg.type().toUpperCase()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    console.error(`[Browser: ${name} ERROR] Unhandled Exception:`, err);
  });
};

export const test = base.extend({
  page: async ({ page }, use) => {
    attachLogs(page, "Default");
    await page.addInitScript(() => {
      const w = window as unknown as {
        __TAURI__?: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
        __TAURI_INTERNALS__?: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
          transformCallback: (callback: unknown) => unknown;
          metadata: {
            rawResult: (result: unknown) => unknown;
          };
        };
      };

      const mockInvoke = async (cmd: string, args?: unknown): Promise<unknown> => {
        console.log(`[Tauri Mock IPC] Invoke: ${cmd}`, args);
        if (cmd === "plugin:shell|spawn" || cmd === "plugin:shell|execute") {
          return { pid: 9999, stdout: "mock stdout", stderr: "" };
        }
        if (cmd === "plugin:dialog|open") {
          return "/mock/dialog/path";
        }
        if (cmd === "plugin:path|app_config_dir") {
          return "/mock/app_config_dir";
        }
        return null;
      };

      w.__TAURI__ = {
        invoke: mockInvoke
      };

      w.__TAURI_INTERNALS__ = {
        invoke: mockInvoke,
        transformCallback: (callback) => callback,
        metadata: {
          rawResult: (result) => result,
        }
      };
    });
    await use(page);
  },
  browser: async ({ browser }, use) => {
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await originalNewContext(options);
      context.on("page", async (page) => {
        attachLogs(page, "Manual");
        await page.addInitScript(() => {
          const w = window as unknown as {
            __TAURI__?: {
              invoke: (cmd: string, args?: unknown) => Promise<unknown>;
            };
            __TAURI_INTERNALS__?: {
              invoke: (cmd: string, args?: unknown) => Promise<unknown>;
              transformCallback: (callback: unknown) => unknown;
              metadata: {
                rawResult: (result: unknown) => unknown;
              };
            };
          };

          const mockInvoke = async (cmd: string, args?: unknown): Promise<unknown> => {
            console.log(`[Tauri Mock IPC] Invoke: ${cmd}`, args);
            if (cmd === "plugin:shell|spawn" || cmd === "plugin:shell|execute") {
              return { pid: 9999, stdout: "mock stdout", stderr: "" };
            }
            if (cmd === "plugin:dialog|open") {
              return "/mock/dialog/path";
            }
            if (cmd === "plugin:path|app_config_dir") {
              return "/mock/app_config_dir";
            }
            return null;
          };

          w.__TAURI__ = {
            invoke: mockInvoke
          };

          w.__TAURI_INTERNALS__ = {
            invoke: mockInvoke,
            transformCallback: (callback) => callback,
            metadata: {
              rawResult: (result) => result,
            }
          };
        });
      });
      return context;
    };
    await use(browser);
  }
});

export { expect, type Page, type BrowserContext } from "@playwright/test";

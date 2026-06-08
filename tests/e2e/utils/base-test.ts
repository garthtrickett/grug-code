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
      (window as any).__TAURI__ = {
        invoke: async (cmd: string, args?: any) => {
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
        }
      };

      (window as any).__TAURI_INTERNALS__ = {
        invoke: (window as any).__TAURI__.invoke,
        transformCallback: (callback: any) => callback,
        metadata: {
          rawResult: (result: any) => result,
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
          (window as any).__TAURI__ = {
            invoke: async (cmd: string, args?: any) => {
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
            }
          };

          (window as any).__TAURI_INTERNALS__ = {
            invoke: (window as any).__TAURI__.invoke,
            transformCallback: (callback: any) => callback,
            metadata: {
              rawResult: (result: any) => result,
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

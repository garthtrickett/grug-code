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
    await use(page);
  },
  browser: async ({ browser }, use) => {
    const originalNewContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await originalNewContext(options);
      context.on("page", (page) => attachLogs(page, "Manual"));
      return context;
    };
    await use(browser);
  }
});

export { expect, type Page, type BrowserContext } from "@playwright/test";

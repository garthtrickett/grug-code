import { test, expect } from "./utils/base-test.ts";

test("Grug Code Frontend Mount Verification", async ({ page }) => {
  // Navigate to loopback dev server port configured in playwright.config.ts (port 42069)
  await page.goto("/");
  
  // Assert that index.html boots up and renders the shell and basic layout elements
  await expect(page.locator("app-shell")).toBeVisible();
});

test("Grug Code Tauri Mock IPC Verification", async ({ page }) => {
  await page.goto("/");

  // Execute a mock Tauri invoke call directly within the window context of the loaded page
  const result = await page.evaluate(async () => {
    const w = window as unknown as {
      __TAURI__?: {
        invoke: (cmd: string) => Promise<string>;
      };
    };
    if (!w.__TAURI__) {
      return "undefined";
    }
    return await w.__TAURI__.invoke("plugin:dialog|open");
  });

  // Verify that the mocked response is returned correctly without crashing the frontend run
  expect(result).toBe("/mock/dialog/path");
});

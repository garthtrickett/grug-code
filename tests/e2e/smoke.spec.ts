import { test, expect } from "./utils/base-test.ts";

test("Grug Code Frontend Mount Verification", async ({ page }) => {
  // Navigate to loopback dev server port configured in playwright.config.ts (port 3001)
  await page.goto("/");
  
  // Assert that index.html boots up and renders the shell and basic layout elements
  await expect(page.locator("app-shell")).toBeVisible();
});

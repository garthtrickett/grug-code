import { test, expect } from "./utils/base-test.ts";

test.describe("Diagnostics - 404 Endpoint Analysis", () => {
  test("should load homepage and intercept all network traffic to pinpoint 404 sources", async ({ page, request }) => {
    const requestedUrls: string[] = [];
    const failedRequests: Array<{ url: string; status: number; headers: Record<string, string> }> = [];

    // Monitor and record all browser request attempts and status results
    page.on("request", (req) => {
      requestedUrls.push(req.url());
    });

    page.on("response", (res) => {
      const status = res.status();
      const url = res.url();
      if (status >= 400) {
        failedRequests.push({
          url,
          status,
          headers: res.headers()
        });
      }
    });

    console.info("\n--- Starting Browser Diagnostics on / ---");
    await page.goto("/");
    await page.waitForTimeout(2000);

    console.info("\n--- Requested URLs inside Browser ---");
    requestedUrls.forEach((url) => console.info(`  🔗 [Request] ${url}`));

    console.info("\n--- 400+ Failed Requests inside Browser ---");
    if (failedRequests.length === 0) {
      console.info("  ✅ No 400+ failures detected directly in browser load phase.");
    } else {
      failedRequests.forEach((fail) => {
        console.warn(`  ❌ [FAIL ${fail.status}] ${fail.url}`);
        console.warn("     Headers:", JSON.stringify(fail.headers, null, 2));
      });
    }

    console.info("\n--- Direct API Endpoint Checks via Playwright Request Context ---");
    const endpoints = [
      "/api/health",
      "/api/projects",
      "/api/workspace/status",
      "/api/mcp/sse",
      "/assets/index-qW_Luqvn.js",
      "/assets/index-CJpvy4pg.css"
    ];

    for (const ep of endpoints) {
      const res = await request.get(ep).catch((err: unknown) => ({
        status: () => -1,
        statusText: () => err instanceof Error ? err.message : String(err),
        headers: () => ({})
      }));
      const status = res.status();
      console.info(`  🔍 [API Check] ${ep} -> Status: ${status}`);
    }
    console.info("-----------------------------------------\n");

    expect(failedRequests.length).toBeLessThan(10);
  });
});

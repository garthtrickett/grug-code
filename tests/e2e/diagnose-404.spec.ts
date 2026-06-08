import { test, expect } from "./utils/base-test.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";

test.describe("Diagnostics - 404 Endpoint Analysis", () => {
  test("should load homepage and intercept all network traffic to pinpoint 404 sources", async ({ page, request }) => {
    const requestedUrls: string[] = [];
    const failedRequests: Array<{ url: string; status: number; headers: any }> = [];

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

    console.log("\n--- Starting Browser Diagnostics on / ---");
    await page.goto("/");
    await page.waitForTimeout(2000);

    console.log("\n--- Requested URLs inside Browser ---");
    requestedUrls.forEach((url) => console.log(`  🔗 [Request] ${url}`));

    console.log("\n--- 400+ Failed Requests inside Browser ---");
    if (failedRequests.length === 0) {
      console.log("  ✅ No 400+ failures detected directly in browser load phase.");
    } else {
      failedRequests.forEach((fail) => {
        console.log(`  ❌ [FAIL ${fail.status}] ${fail.url}`);
        console.log("     Headers:", JSON.stringify(fail.headers, null, 2));
      });
    }

    console.log("\n--- Direct API Endpoint Checks via Playwright Request Context ---");
    const endpoints = [
      "/api/health",
      "/api/projects",
      "/api/workspace/status",
      "/api/mcp/sse",
      "/assets/index-qW_Luqvn.js",
      "/assets/index-CJpvy4pg.css"
    ];

    for (const ep of endpoints) {
      const res = await request.get(ep).catch((err) => ({
        status: () => -1,
        statusText: () => err.message,
        headers: () => ({})
      }));
      const status = res.status();
      console.log(`  🔍 [API Check] ${ep} -> Status: ${status}`);
    }
    console.log("-----------------------------------------\n");

    expect(failedRequests.length).toBeLessThan(10);
  });
});

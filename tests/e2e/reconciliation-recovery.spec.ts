import { test, expect } from "./utils/base-test.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Task Board - Transaction Reconciliation and Recovery E2E", () => {
  let tempDir: string;
  let sessionToken: string;

  test.beforeAll(async () => {
    // Read local loopback session token securely
    const fileContent = await fs.readFile(".grug-session.json", "utf-8");
    const sessionData = JSON.parse(fileContent) as { token: string };
    sessionToken = sessionData.token;

    // Enable cross-process mock AI signaling
    await fs.writeFile(".grug-mock-ai", "true");
  });

  test.afterAll(async () => {
    await fs.unlink(".grug-mock-ai").catch(() => {});
  });

  test.beforeEach(async () => {
    // Setup clean isolated sandbox repository
    tempDir = path.join(process.cwd(), `.grug-e2e-recovery-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug Recovery Test'", { cwd: tempDir });
    await execPromise("git config user.email 'recovery@grug.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Original codebase line.\n");
    await execPromise("git add initial.txt", { cwd: tempDir });
    await execPromise("git commit -m 'E2E Init Commit'", { cwd: tempDir });
  });

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should seamlessly recover transaction state and auto-resume execution after a page reload", async ({ page }) => {
    // 1. Load login page, write credentials to bypass, set workspace sandboxes
    await page.goto("/");
    await page.evaluate(({ token, cwd }) => {
      localStorage.setItem("grug-token", token);
      localStorage.setItem("grug-cwd", cwd);
      localStorage.setItem("jwt", "mock-auth-jwt");
    }, { token: sessionToken, cwd: tempDir });

    // 2. Reload to navigate and boot directly onto the active workspace dashboard
    await page.reload();

    // 3. Assert Launch Development Session form is displayed
    const heading = page.locator("grug-task-board h2");
    await expect(heading).toContainText("Launch Development Session");

    // 4. Fill form inputs to start planning
    await page.fill("input[name='description']", "E2E transaction recovery test");
    await page.click("button[type='submit']");

    // 5. Assert proposal page transition
    const proposalHeader = page.locator("grug-task-board h2");
    await expect(proposalHeader).toContainText("Proposed Development Plan");

    // 6. Click start transaction
    await page.click("button:has-text('Approve & Start Task Transaction')");

    // 7. Assert transition to transaction view
    const txHeader = page.locator("grug-task-board h2");
    await expect(txHeader).toContainText("Workspace Transaction:");

    // Verify .grug-active-transaction.json metadata file was written to disk by server
    const stateFile = path.join(tempDir, ".grug-active-transaction.json");
    await expect(async () => {
      const exists = await fs.stat(stateFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    }).toPass({ timeout: 5000 });

    // 8. Trigger a sudden hard browser reload while the queue is active
    console.info("[E2E Recovery] Simulating sudden page refresh / Vite HMR reload...");
    await page.reload();

    // 9. Verify the page reboots cleanly, detects the active transaction on boot, and recovers state
    const postReloadHeader = page.locator("grug-task-board h2");
    await expect(postReloadHeader).toContainText("Workspace Transaction:");

    // Assert checkpoints list and step details are restored
    const firstStep = page.locator("grug-task-board h4").first();
    await expect(firstStep).toBeVisible();

    // 10. Clean up and abort transaction safely
    const abortBtn = page.locator("grug-task-board button:has-text('Abort Task')");
    await expect(abortBtn).toBeVisible();
    await abortBtn.click();

    // Confirm dashboard has safely reset back to initialization view
    await expect(heading).toContainText("Launch Development Session");

    // Ensure state file was deleted cleanly on disk
    const existsAfterAbort = await fs.stat(stateFile).then(() => true).catch(() => false);
    expect(existsAfterAbort).toBe(false);
  });
});

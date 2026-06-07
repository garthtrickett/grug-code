import { test, expect } from "./utils/base-test.ts";
import { createTestProject, deleteTestProject } from "./utils/seed.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Code Scoped Directory Selector E2E", () => {
  let tempDir: string;
  let sessionToken: string;
  let projectId: string;

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
    tempDir = path.join(process.cwd(), `.grug-e2e-scoped-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug Scoped Test'");
    await execPromise("git config user.email 'scoped@grug.com'");
    await execPromise("git config commit.gpgSign false");

    // Seed dummy subfolders
    await fs.mkdir(path.join(tempDir, "subapps/service"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "packages/core"), { recursive: true });
    
    // Seed initial files
    await fs.writeFile(path.join(tempDir, "subapps/service/worker.ts"), "const run = () => {};\n");
    await fs.writeFile(path.join(tempDir, "packages/core/index.ts"), "export const value = 1;\n");
    
    await execPromise("git add .", { cwd: tempDir });
    await execPromise("git commit -m 'E2E Init Scoped Commit'", { cwd: tempDir });
    projectId = await createTestProject("Scoped Test Project", tempDir);
  });

  test.afterEach(async () => {
    await deleteTestProject(projectId);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should successfully configure workspace scope, select subdirectory dropdown option, and initialize transaction", async ({ page }) => {
    // 1. Load dashboard and configure workspace pathing to sandboxed repo
    await page.goto("/");
    await page.evaluate(({ token, cwd }) => {
      localStorage.setItem("grug-token", token);
      localStorage.setItem("grug-cwd", cwd);
      localStorage.setItem("jwt", "mock-auth-jwt");
    }, { token: sessionToken, cwd: tempDir });

    // 2. Reload page to initialize stores
    await page.reload();

    // 3. Confirm form heading is visible
    const heading = page.locator("grug-task-board h2");
    await expect(heading).toContainText("Launch Development Session");

    // 4. Click the directory scope trigger dropdown
    const selectTrigger = page.locator("grug-task-board button#directory-scope-select-trigger");
    await expect(selectTrigger).toBeVisible();
    await selectTrigger.click();

    // 5. Select the "subapps/service" option inside dropdown
    const targetOption = page.locator("grug-task-board li[role='option']").filter({ hasText: "subapps/service" });
    await expect(targetOption).toBeVisible();
    await targetOption.click();

    // 6. Assert trigger button updates to show selected scope name
    await expect(selectTrigger).toContainText("subapps/service");

    // 7. Fill in task configuration parameters
    await page.fill("input[name='description']", "Verify subfolder scoping");

    // 8. Submit initialization form
    await page.click("grug-task-board button[type='submit']");

    // 9. Assert proposal page transition
    const proposalHeader = page.locator("grug-task-board h2");
    await expect(proposalHeader).toContainText("Proposed Development Plan");

    // 10. Click start transaction
    await page.click("button:has-text('Approve & Start Task Transaction')");

    // 11. Confirm active transaction screen is displayed
    const txHeader = page.locator("grug-task-board h2");
    await expect(txHeader).toContainText("Workspace Transaction:");

    // 12. Check branch configuration inside UI
    const ephemeralDetails = page.locator("grug-task-board p").filter({ hasText: "Ephemeral Branch" });
    await expect(ephemeralDetails).toContainText("grug-task/");

    // 11. Abort task cleanly to restore repository
    const abortBtn = page.locator("grug-task-board button:has-text('Abort Task')");
    await expect(abortBtn).toBeVisible();
    await abortBtn.click();

    // 12. Confirm dashboard reset
    await expect(heading).toContainText("Launch Development Session");
  });
});

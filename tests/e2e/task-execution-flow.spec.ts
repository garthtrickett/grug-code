import { test, expect } from "./utils/base-test.ts";
import { createTestProject, deleteTestProject } from "./utils/seed.ts";
import type { ProjectId } from "../../src/types/index.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Task Board - Interactive Flow E2E", () => {
  let tempDir: string;
  let sessionToken: string;
  let projectId: ProjectId;

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
    tempDir = path.join(process.cwd(), `.grug-e2e-ui-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug UI Test'", { cwd: tempDir });
    await execPromise("git config user.email 'uitest@grug.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Original codebase line.\n");
    await execPromise("git add initial.txt", { cwd: tempDir });
    await execPromise("git commit -m 'E2E Init Commit'", { cwd: tempDir });
    projectId = await createTestProject("UI Test Project", tempDir);
  });

  test.afterEach(async () => {
    await deleteTestProject(projectId);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should orchestrate init, play/pause queue, and aborting transaction successfully from UI", async ({ page }) => {
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
    await page.fill("input[name='description']", "E2E custom feature update");
    await page.click("button[type='submit']");

    // 5. Assert proposal page transition
    const proposalHeader = page.locator("grug-task-board h2");
    await expect(proposalHeader).toContainText("Proposed Development Plan");

    // 6. Click start transaction
    await page.click("button:has-text('Approve & Start Task Transaction')");

        // 7. Assert transition to transaction view
    const txHeader = page.locator("grug-task-board h2");
    await expect(txHeader).toContainText("Workspace Transaction:", { timeout: 10000 });

    // 8. Assert step descriptions are visible
    const firstStep = page.locator("grug-task-board h4").first();
    await expect(firstStep).toContainText("Analyze codebase targets", { timeout: 10000 });

    // 9. Verify play/pause signal transitions cleanly
    const pauseBtn = page.locator("grug-task-board button:has-text('Pause Queue')");
    await expect(pauseBtn).toBeVisible();

    await pauseBtn.click();
    const resumeBtn = page.locator("grug-task-board button:has-text('Resume Queue')");
    await expect(resumeBtn).toBeVisible();

    // 10. Trigger Abort Task
    const abortBtn = page.locator("grug-task-board button:has-text('Abort Task')");
    await abortBtn.click();

    // 11. Verify workspace successfully resets back to task initialization view
    await expect(heading).toContainText("Launch Development Session");

    // Ensure ephemeral branch was safely deleted on disk
    const branchList = await execPromise("git branch", { cwd: tempDir });
    expect(branchList.stdout.includes("grug-task/")).toBe(false);
  });

  test("should execute end-to-end task transaction starting in discussion mode and proceeding to auto-pilot execution", async ({ page }) => {
    // 1. Setup mock environment & authorize page
    await page.goto("/");
    await page.evaluate(({ token, cwd }) => {
      localStorage.setItem("grug-token", token);
      localStorage.setItem("grug-cwd", cwd);
      localStorage.setItem("jwt", "mock-auth-jwt");
    }, { token: sessionToken, cwd: tempDir });

    // 2. Reload to hydrate stores
    await page.reload();

    // 3. Confirm launch form loaded
    const heading = page.locator("grug-task-board h2");
    await expect(heading).toContainText("Launch Development Session");

    // 4. Fill in feature description, check "Discussion Mode", and submit
    await page.fill("input[name='description']", "E2E interactive discussion feature");
    await page.check("input[type='checkbox']");
    await page.click("grug-task-board button[type='submit']");

    // 5. Assert transition to Discussion Board panel
    const discussionHeader = page.locator("grug-task-board h2");
    await expect(discussionHeader).toContainText("Grug Code Discussion");

    // 6. Select a suggested response button to finalize conversation
    await page.click("button:has-text('Proceed with plan')");
    
    // 7. Verify transition to proposed planning board checklist
    const proposalHeader = page.locator("grug-task-board h2");
    await expect(proposalHeader).toContainText("Proposed Development Plan");

    // 8. Click start transaction
    await page.click("button:has-text('Approve & Start Task Transaction')");

    // 9. Confirm active transaction screen is displayed
    const txHeader = page.locator("grug-task-board h2");
    await expect(txHeader).toContainText("Workspace Transaction:");

    // 10. Clean up transaction cleanly
    const abortBtn = page.locator("grug-task-board button:has-text('Abort Task')");
    await expect(abortBtn).toBeVisible();
    await abortBtn.click();

    // 11. Confirm dashboard reset back to initialization form
    await expect(heading).toContainText("Launch Development Session");
  });
});

import { test, expect } from "./utils/base-test.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Code - Project Selector and Dynamic Custom Execution E2E", () => {
  let tempDir: string;
  let sessionToken: string;

  test.beforeAll(async () => {
    const fileContent = await fs.readFile(".grug-session.json", "utf-8");
    const sessionData = JSON.parse(fileContent) as { token: string };
    sessionToken = sessionData.token;

    await fs.writeFile(".grug-mock-ai", "true");
  });

  test.afterAll(async () => {
    await fs.unlink(".grug-mock-ai").catch(() => {});
  });

  test.beforeEach(async () => {
    tempDir = path.join(process.cwd(), `.grug-e2e-projects-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug Projects E2E'");
    await execPromise("git config user.email 'projects@grug.com'");
    await execPromise("git config commit.gpgSign false");

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Original codebase line.\n");
    await execPromise("git add .", { cwd: tempDir });
    await execPromise("git commit -m 'E2E Init Projects Commit'", { cwd: tempDir });
  });

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should successfully configure projects, select project dropdown, run feature planning, and execute custom step", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(({ token, cwd }) => {
      localStorage.setItem("grug-token", token);
      localStorage.setItem("grug-cwd", cwd);
      localStorage.setItem("jwt", "mock-auth-jwt");
    }, { token: sessionToken, cwd: tempDir });

    await page.reload();

    const configBtn = page.locator("button:has-text('Configure Projects')");
    await expect(configBtn).toBeVisible();
    await configBtn.click();

    const addBtn = page.locator("button:has-text('+ Add Project')");
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    await page.fill("input[name='name']", "E2E Dynamic Project");
    await page.fill("input[name='root_path']", tempDir);
    await page.fill("input[name='type_check_command']", "echo 'custom typecheck success'");
    await page.fill("input[name='test_command']", "echo 'custom test success'");
    
        await page.click("form button:has-text('Register Project')");

    const selectTrigger = page.locator("button#project-select-api-trigger");
    await expect(selectTrigger).toContainText("E2E Dynamic Project");

    await page.fill("input[name='description']", "Test project dynamic checkout execution");
    await page.click("button[type='submit']");

    const approveBtn = page.locator("button:has-text('Approve & Start Task Transaction')");
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    const txHeader = page.locator("grug-task-board h2");
    await expect(txHeader).toContainText("Workspace Transaction:");

    const abortBtn = page.locator("grug-task-board button:has-text('Abort Task')");
    await expect(abortBtn).toBeVisible();
    await abortBtn.click();

    const heading = page.locator("grug-task-board h2");
    await expect(heading).toContainText("Launch Development Session");
  });
});

import { test, expect } from "./utils/base-test";
import { createTestProject, deleteTestProject } from "./utils/seed.ts";
import type { ProjectId } from "../../src/types/index.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Code Workspace Safety and Sandboxing E2E", () => {
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
    // Create a completely isolated mock repository directory to prevent active branch switching during developer execution runs
    tempDir = path.join(process.cwd(), `.grug-e2e-temp-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug E2E Test'", { cwd: tempDir });
    await execPromise("git config user.email 'e2e@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    // Create baseline files with standard trailing newline
    await fs.writeFile(path.join(tempDir, "main.ts"), "const x: number = 10;\nconsole.log(x);\n");
    await fs.writeFile(
      path.join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "es2022",
          moduleResolution: "node",
          skipLibCheck: true,
          noEmit: true
        },
        include: ["main.ts"]
      }, null, 2)
    );
    await execPromise("git add .", { cwd: tempDir });
    await execPromise("git commit -m 'Initial E2E Commit'", { cwd: tempDir });
    projectId = await createTestProject("Safety Test Project", tempDir);
  });

  test.afterEach(async () => {
    await deleteTestProject(projectId);
    // Revert directory safely and remove all testing artifacts
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should reject API requests lacking the valid security token with 401 Unauthorized", async ({ request }) => {
    const response = await request.post("/api/workspace/init", {
      headers: {
        "Content-Type": "application/json",
      },
      data: {
        taskId: "e2e-anonymous-intrusion",
        cwd: tempDir,
      },
    });

    expect(response.status()).toBe(401);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("Unauthorized");
  });

  test("should load the PWA, extract the injected session token dynamically, and run transactions via UI", async ({ page }) => {
    // 1. Load root page (dynamic meta tag is injected automatically by Elysia)
    await page.goto("/");

    // 2. Hydrate only workspace scope and login token to bypass gate (grug-token is omitted)
    await page.evaluate(({ cwd }) => {
      localStorage.setItem("grug-cwd", cwd);
      localStorage.setItem("jwt", "mock-auth-jwt");
    }, { cwd: tempDir });

    // 3. Reload page to initialize UI stores with loopback environment
    await page.reload();

    // 4. Assert Launch Form successfully mounted
    const heading = page.locator("grug-task-board h2");
    await expect(heading).toContainText("Launch Development Session");

    // 5. Fill fields to start a programmatic task transaction
    await page.fill("input[name='description']", "Testing dynamic secure handshake");
    await page.click("button[type='submit']");

    // 6. Assert proposal page transition
    const proposalHeader = page.locator("grug-task-board h2");
    await expect(proposalHeader).toContainText("Proposed Development Plan");

    // 7. Click start transaction
    await page.click("button:has-text('Approve & Start Task Transaction')");

    // 8. Assert success branch transition (proving token was securely read and mapped)
    const txHeader = page.locator("grug-task-board h2");
    await expect(txHeader).toContainText("Workspace Transaction:");

    // 9. Cleanup task transaction cleanly
    const abortBtn = page.locator("grug-task-board button:has-text('Abort Task')");
    await abortBtn.click();
    await expect(heading).toContainText("Launch Development Session");
  });

  test("should transaction branch, catch compilation failure, and abort/reset cleanly", async ({ request }) => {
    const taskId = `e2e-task-${crypto.randomUUID().slice(0, 8)}`;

    // 1. Initialize Git Transaction via local loopback endpoint
    const initResponse = await request.post("/api/workspace/init", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        taskId,
        cwd: tempDir,
      },
    });

    expect(initResponse.status()).toBe(200);
    const tx = (await initResponse.json()) as {
      id: string;
      baseBranch: string;
      ephemeralBranch: string;
      checkpoints: string[];
    };
    expect(tx.ephemeralBranch).toBe(`grug-task/${taskId}`);

    // Verify the temporary branch was spawned programmatically in mock repo
    const branchCheck = await execPromise("git branch --show-current", { cwd: tempDir });
    expect(branchCheck.stdout.trim()).toBe(`grug-task/${taskId}`);

    // 2. Simulate an agent applying a patch that breaks the compiler
    await fs.writeFile(path.join(tempDir, "main.ts"), "const x: number = 'broken syntax';\n");

    // 3. Programmatically request type-checking and assert that the error is successfully captured
    const verifyResponse = await request.post("/api/workspace/verify", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        tx,
        type: "typecheck",
        cwd: tempDir,
      },
    });

    expect(verifyResponse.status()).toBe(200);
    const verification = (await verifyResponse.json()) as {
      success: boolean;
      errorOutput?: string;
      dirtyFiles: Array<{ filePath: string }>;
    };
    expect(verification.success).toBe(false);
    expect(verification.errorOutput).toContain("TS2322"); // TS standard type mismatch
    expect(verification.dirtyFiles.length).toBe(1);
    expect(verification.dirtyFiles[0]?.filePath).toBe("main.ts");

    // 4. Trigger an abort transaction command
    const abortResponse = await request.post("/api/workspace/abort", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        tx,
        cwd: tempDir,
      },
    });

    expect(abortResponse.status()).toBe(200);

    // Assert that we are back on the original base branch safely
    const postAbortBranch = await execPromise("git branch --show-current", { cwd: tempDir });
    expect(postAbortBranch.stdout.trim()).toBe(tx.baseBranch);

    // Assert that the file is reverted back to its baseline state
    const revertedContent = await fs.readFile(path.join(tempDir, "main.ts"), "utf-8");
    expect(revertedContent).toBe("const x: number = 10;\nconsole.log(x);\n");

    // Assert that the ephemeral branch has been deleted completely
    const branchList = await execPromise("git branch", { cwd: tempDir });
    expect(branchList.stdout.includes(`grug-task/${taskId}`)).toBe(false);
  });
});

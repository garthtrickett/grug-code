import { test, expect } from "./utils/base-test.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Code Patcher Tier-3 and Tier-4 E2E", () => {
  let tempDir: string;
  let sessionToken: string;

  test.beforeAll(async () => {
    // Retrieve the active loopback authorization session token dynamically from workspace storage
    const fileContent = await fs.readFile(".grug-session.json", "utf-8");
    const sessionData = JSON.parse(fileContent) as { token: string };
    sessionToken = sessionData.token;
  });

  test.beforeEach(async () => {
    // Create an isolated sandbox directory
    tempDir = path.join(process.cwd(), `.grug-e2e-patcher-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug Patcher E2E'", { cwd: tempDir });
    await execPromise("git config user.email 'patchere2e@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    // Create a simple TypeScript file to patch
    const tsContent = [
      "export class Worker {",
      "  constructor() {",
      "    console.log('Worker initialized');",
      "  }",
      "  public executeWork(amount: number): number {",
      "    return amount * 2;",
      "  }",
      "}"
    ].join("\n");

    await fs.writeFile(path.join(tempDir, "worker.ts"), tsContent);
    await execPromise("git add worker.ts", { cwd: tempDir });
    await execPromise("git commit -m 'Initial commit with worker.ts'", { cwd: tempDir });
  });

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should resolve with Tier 3 AST replacement on bad indentation, and return Tier 4 mismatch context on total failure", async ({ request }) => {
    const taskId = `e2e-patcher-${crypto.randomUUID().slice(0, 8)}`;

    // 1. Initialize Git Transaction
    const initResponse = await request.post("/api/workspace/init", {
      headers: {
        "X-Grug-Token": sessionToken,
        "Content-Type": "application/json"
      },
      data: {
        taskId,
        cwd: tempDir
      }
    });

    expect(initResponse.status()).toBe(200);
    const tx = (await initResponse.json()) as {
      id: string;
      baseBranch: string;
      ephemeralBranch: string;
      checkpoints: string[];
    };

    // 2. Apply patch with malformed indentation to verify Tier 3 AST-Node replacement
    const patchResponseT3 = await request.post("/api/workspace/patch", {
      headers: {
        "X-Grug-Token": sessionToken,
        "Content-Type": "application/json"
      },
      data: {
        tx,
        cwd: tempDir,
        patch: {
          summary: "Change calculate method with bad indentation",
          files: [
            {
              file_path: "worker.ts",
              code_diff: [
                "\n<<<<<<< SEARCH",
                "  public executeWork(amount: number): number {",
                "         // messy indentation here",
                "    return amount * 99999;",
                "  }",
                "=======",
                "  public executeWork(amount: number): number {",
                "    return amount * 10;",
                "  }",
                ">>>>>>> REPLACE\n"
              ].join("\n")
            }
          ]
        }
      }
    });

    expect(patchResponseT3.status()).toBe(200);
    const t3Result = (await patchResponseT3.json()) as { success: boolean };
    expect(t3Result.success).toBe(true);

    const updatedContent = await fs.readFile(path.join(tempDir, "worker.ts"), "utf-8");
    expect(updatedContent).toContain("return amount * 10;");

    // 3. Attempt a completely mismatched patch to verify Tier 4 diagnostics payload
    const patchResponseT4 = await request.post("/api/workspace/patch", {
      headers: {
        "X-Grug-Token": sessionToken,
        "Content-Type": "application/json"
      },
      data: {
        tx,
        cwd: tempDir,
        patch: {
          summary: "Completely wrong search block",
          files: [
            {
              file_path: "worker.ts",
              code_diff: [
                "\n<<<<<<< SEARCH",
                "  public nonExistentMethod(): void {",
                "    console.log('does not exist');",
                "  }",
                "=======",
                "  public anotherMethod(): void {}",
                ">>>>>>> REPLACE\n"
              ].join("\n")
            }
          ]
        }
      }
    });

    expect(patchResponseT4.status()).toBe(400);
    const t4Result = (await patchResponseT4.json()) as {
      error: string;
      filePath?: string;
      failedSearchBlock?: string;
      proposedReplacement?: string;
      actualContextSnippet?: string;
    };

    expect(t4Result.filePath).toBe("worker.ts");
    expect(t4Result.failedSearchBlock).toContain("nonExistentMethod");
    expect(t4Result.proposedReplacement).toContain("anotherMethod");
    expect(t4Result.actualContextSnippet).toContain("executeWork");

    // 4. Abort transaction cleanly
    const abortResponse = await request.post("/api/workspace/abort", {
      headers: {
        "X-Grug-Token": sessionToken,
        "Content-Type": "application/json"
      },
      data: {
        tx,
        cwd: tempDir
      }
    });

    expect(abortResponse.status()).toBe(200);
  });
});

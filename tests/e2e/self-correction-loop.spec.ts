import { test, expect } from "./utils/base-test.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Code Self-Correction Loop E2E", () => {
  let tempDir: string;
  let sessionToken: string;

  test.beforeAll(async () => {
    // Read secure loopback token
    const fileContent = await fs.readFile(".grug-session.json", "utf-8");
    const sessionData = JSON.parse(fileContent) as { token: string };
    sessionToken = sessionData.token;

    // Enable cross-process mock AI signaling
    await fs.writeFile(".grug-mock-ai", "true");
  });

  test.beforeEach(async () => {
    tempDir = path.join(process.cwd(), `.grug-e2e-correction-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug E2E Test'", { cwd: tempDir });
    await execPromise("git config user.email 'e2e@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    // 1. Setup real baseline code and native assertions
    await fs.writeFile(path.join(tempDir, "main.ts"), "export const x: number = 42;\n");
    await fs.writeFile(
      path.join(tempDir, "main.test.ts"),
      [
        "import { expect, test } from 'vitest';",
        "import { x } from './main.ts';",
        "",
        "test('assert correctness', () => {",
        "  expect(x).toBe(42);",
        "});",
        ""
      ].join("\n")
    );
                    await fs.writeFile(
      path.join(tempDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "es2022",
          moduleResolution: "bundler",
          module: "es2022",
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          noEmit: true
        },
        include: ["main.ts", "main.test.ts"]
      }, null, 2)
    );

        await fs.writeFile(
      path.join(tempDir, "vitest.config.ts"),
      [
        "import { defineConfig } from 'vitest/config';",
        "",
        "export default defineConfig({",
        "  test: {",
        "    include: ['main.test.ts'],",
        "    environment: 'node',",
        "  },",
        "});"
      ].join("\n")
    );

    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "e2e-sandbox",
        type: "module",
        scripts: {
          test: "vitest run --config vitest.config.ts"
        }
      }, null, 2)
    );

    await execPromise("git add .", { cwd: tempDir });
    await execPromise("git commit -m 'Initial baseline commit'", { cwd: tempDir });
  });

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test.afterAll(async () => {
    await fs.unlink(".grug-mock-ai").catch(() => {});
  });

  test("should execute task step, detect broken type signature, self-heal, run unit tests, and save git checkpoint successfully", async ({ request }) => {
    const taskId = `e2e-correct-${crypto.randomUUID().slice(0, 8)}`;

    // 1. Initialize active Git Transaction via API
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

    // 2. Dispatch execute-step task with instructions to apply a broken compiler patch first
    const executeResponse = await request.post("/api/workspace/execute-step", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        tx,
        targetFiles: ["main.ts"],
        instructions: JSON.stringify({
          summary: "Apply broken type edits",
          files: [
            {
              file_path: "main.ts",
              code_diff: [
                "<<<<<<< SEARCH",
                "export const x: number = 42;",
                "=======",
                "export const x: number = 'broken';",
                ">>>>>>> REPLACE"
              ].join("\n")
            }
          ]
        }),
        cwd: tempDir,
      },
    });

            interface ExecutionStepResponse {
      readonly status: string;
      readonly worktreePath: string;
      readonly ephemeralBranch: string;
      readonly tx: {
        readonly id: string;
        readonly baseBranch: string;
        readonly ephemeralBranch: string;
        readonly checkpoints: readonly string[];
      };
    }

    interface WorkspaceStatusResponse {
      readonly tx: {
        readonly id: string;
        readonly baseBranch: string;
        readonly ephemeralBranch: string;
        readonly checkpoints: readonly string[];
      };
      readonly tasks: readonly unknown[];
    }

    expect(executeResponse.status()).toBe(200);
    const asyncRes = (await executeResponse.json()) as ExecutionStepResponse;
    expect(asyncRes.status).toBe("running");

    const worktreePath = asyncRes.worktreePath;
    let completed = false;
    for (let i = 0; i < 40; i++) {
      const exists = await fs.stat(worktreePath).then(() => true).catch(() => false);
      if (!exists && i > 5) {
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(completed).toBe(true);

    // Now query the status endpoint to verify the transaction successfully reconciled checkpoints
    const statusResponse = await request.get(`/api/workspace/status?cwd=${encodeURIComponent(tempDir)}`, {
      headers: {
        "X-Grug-Token": sessionToken,
      }
    });
    expect(statusResponse.status()).toBe(200);
    const statusData = (await statusResponse.json()) as WorkspaceStatusResponse; 
    expect(statusData).not.toBeNull();
    expect(statusData.tx).toBeDefined();
    expect(statusData.tx.checkpoints.length).toBe(1);

    // Verify final file is corrected back to valid type and passing value (42)
    const finalContent = await fs.readFile(path.join(tempDir, "main.ts"), "utf-8");
    expect(finalContent).toContain("export const x: number = 42;");

    // Clean up transaction
    const abortResponse = await request.post("/api/workspace/abort", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        tx: statusData.tx,
        cwd: tempDir,
      },
    });
    expect(abortResponse.status()).toBe(200);
  });
});

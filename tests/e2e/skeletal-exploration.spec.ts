import { test, expect } from "./utils/base-test.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Code Skeletal Exploration E2E", () => {
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
    tempDir = path.join(process.cwd(), `.grug-e2e-skeleton-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug E2E Test'", { cwd: tempDir });
    await execPromise("git config user.email 'e2e@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    // Create a TypeScript file containing rich structures (interface, function with body)
    const tsContent = [
      'export interface Item {',
      '  id: string;',
      '  value: number;',
      '}',
      '',
      'export function processItem(item: Item): void {',
      '  const ratio = item.value * 2;',
      '  console.log("processing item in details", ratio);',
      '}',
      ''
    ].join("\n");

    await fs.writeFile(path.join(tempDir, "worker.ts"), tsContent);
    await execPromise("git add worker.ts", { cwd: tempDir });
    await execPromise("git commit -m 'Initial commit with worker.ts'", { cwd: tempDir });
  });

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should authenticate, initialize task transaction, and request file skeletons successfully", async ({ request }) => {
    const taskId = `e2e-explore-${crypto.randomUUID().slice(0, 8)}`;

    // 1. Initialize Git Transaction
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

    // 2. Query `/skeletons` API endpoint
    const skeletonsResponse = await request.post("/api/workspace/skeletons", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        tx,
        paths: ["worker.ts"],
        cwd: tempDir,
      },
    });

    expect(skeletonsResponse.status()).toBe(200);
    const result = (await skeletonsResponse.json()) as Array<{
      filePath: string;
      content: string;
      error?: string;
    }>;

    expect(result.length).toBe(1);
    expect(result[0]?.filePath).toBe("worker.ts");
    expect(result[0]?.error).toBeUndefined();

    const skeletonContent = result[0]?.content || "";

    // Verify type definitions & signatures are intact
    expect(skeletonContent).toContain("export interface Item");
    expect(skeletonContent).toContain("export function processItem(item: Item): void");

    // Verify logic/implementation bodies are stripped into empty statement blocks
    expect(skeletonContent).toContain("processItem(item: Item): void {}");
    expect(skeletonContent).not.toContain("const ratio = ");
    expect(skeletonContent).not.toContain("processing item in details");

    // 3. Abort transaction cleanly
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
  });
});

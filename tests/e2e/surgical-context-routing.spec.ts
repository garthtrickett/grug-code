import { test, expect } from "./utils/base-test.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(exec);

test.describe("Grug Code Surgical Context Routing and Anchor Assembly E2E", () => {
  let tempDir: string;
  let sessionToken: string;

  test.beforeAll(async () => {
    const fileContent = await fs.readFile(".grug-session.json", "utf-8");
    const sessionData = JSON.parse(fileContent) as { token: string };
    sessionToken = sessionData.token;
  });

  test.beforeEach(async () => {
    tempDir = path.join(process.cwd(), `.grug-e2e-surgical-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug E2E Test'", { cwd: tempDir });
    await execPromise("git config user.email 'e2e@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    const codeContent = [
      "export function computeResult(val: number): number {",
      "  console.log('calculating dynamic result');",
      "  return val * 10;",
      "}",
      "",
      "export function anotherFunction(): void {",
      "  console.log('should be hollowed out');",
      "}"
    ].join("\n");

    await fs.writeFile(path.join(tempDir, "computation.ts"), codeContent);
    await execPromise("git add computation.ts", { cwd: tempDir });
    await execPromise("git commit -m 'initial commit'", { cwd: tempDir });
  });

  test.afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  test("should route small targets to DIRECT, route exceeding targets to SURGICAL, and assemble anchors selectively", async ({ request }) => {
    const taskId = `e2e-surgical-${crypto.randomUUID().slice(0, 8)}`;

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

    // 2. Request route estimation for small setup
    const routeSmallResponse = await request.post("/api/workspace/route-execution", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        paths: ["computation.ts"],
        cwd: tempDir,
      },
    });

    expect(routeSmallResponse.status()).toBe(200);
    const routeSmall = await routeSmallResponse.json() as { path: string };
    expect(routeSmall.path).toBe("DIRECT");

    // 3. Request route estimation exceeding direct limits
    const routeLargeResponse = await request.post("/api/workspace/route-execution", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        paths: ["computation.ts", "dummy1.ts", "dummy2.ts", "dummy3.ts"],
        cwd: tempDir,
      },
    });

    expect(routeLargeResponse.status()).toBe(200);
    const routeLarge = await routeLargeResponse.json() as { path: string; reason: string };
    expect(routeLarge.path).toBe("SURGICAL");
    expect(routeLarge.reason).toContain("File count exceeds the direct routing threshold");

    // 4. Request selectively assembled anchors
    const assembleResponse = await request.post("/api/workspace/assemble-anchors", {
      headers: {
        "Content-Type": "application/json",
        "X-Grug-Token": sessionToken,
      },
      data: {
        tx,
        paths: ["computation.ts"],
        anchors: [
          { entityType: "function", entityName: "computeResult" }
        ],
        cwd: tempDir,
      },
    });

    expect(assembleResponse.status()).toBe(200);
    const assembleResult = (await assembleResponse.json()) as Array<{
      filePath: string;
      content: string;
      error?: string;
    }>;

    expect(assembleResult.length).toBe(1);
    const fileOutput = assembleResult[0]?.content || "";

    // Verify 'computeResult' function body is preserved fully
    expect(fileOutput).toContain("calculating dynamic result");
    expect(fileOutput).not.toContain("computeResult(val: number): number {}");

    // Verify 'anotherFunction' is hollowed out cleanly
    expect(fileOutput).not.toContain("should be hollowed out");
    expect(fileOutput).toContain("anotherFunction(): void {}");

    // 5. Abort cleanly
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

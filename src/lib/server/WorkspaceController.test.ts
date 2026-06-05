import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { makeWorkspaceController } from "./WorkspaceController";

const execPromise = promisify(exec);

describe("WorkspaceController - Git Transaction Core", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create an isolated temp directory for running safe git simulations
    tempDir = path.join(process.cwd(), `.grug-temp-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Initialize Git in test directory
    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug Test'", { cwd: tempDir });
    await execPromise("git config user.email 'grug@test.com'", { cwd: tempDir });
    await execPromise("git config commit.gpgSign false", { cwd: tempDir });

    // Create an initial commit with standard trailing newline
    await fs.writeFile(path.join(tempDir, "initial.txt"), "Grug initialize codebase.\n");
    await execPromise("git add initial.txt", { cwd: tempDir });
    await execPromise("git commit -m 'initial commit'", { cwd: tempDir });
  });

  afterEach(async () => {
    // Cleanup test directory safely
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should initiate transaction only if workspace status is clean", async () => {
    const controller = makeWorkspaceController(tempDir);

    // 1. First run on clean workspace
    const runClean = controller.initTransaction("task-123");
    const tx = await Effect.runPromise(runClean);
    expect(tx.baseBranch).toBeDefined();
    expect(tx.ephemeralBranch).toBe("grug-task/task-123");

    // Cleanup task branch before proceeding
    await execPromise(`git checkout ${tx.baseBranch}`, { cwd: tempDir });
    await execPromise(`git branch -D ${tx.ephemeralBranch}`, { cwd: tempDir });

    // 2. Introduce dirty files
    await fs.writeFile(path.join(tempDir, "dirty.txt"), "Dirty untracked file.\n");

    const runDirty = controller.initTransaction("task-456");
    await expect(Effect.runPromise(runDirty)).rejects.toThrow();
  });

  it("should support creating checkpoints and returning accurate milestone lists", async () => {
    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-789"));

    // Modify file
    await fs.writeFile(path.join(tempDir, "initial.txt"), "Grug edit 1.\n");
    const tx2 = await Effect.runPromise(controller.createCheckpoint(tx, "edit 1"));

    expect(tx2.checkpoints.length).toBe(1);
    expect(tx2.checkpoints[0]).toBeDefined();

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Grug edit 2.\n");
    const tx3 = await Effect.runPromise(controller.createCheckpoint(tx2, "edit 2"));

    expect(tx3.checkpoints.length).toBe(2);

    // Cleanup
    await Effect.runPromise(controller.abortTransaction(tx3));
  });

  it("should rollback to checkpoints accurately, wiping dirty files", async () => {
    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-abc"));

    await fs.writeFile(path.join(tempDir, "initial.txt"), "First change.\n");
    const checkpoint1 = await Effect.runPromise(controller.createCheckpoint(tx, "c1"));
    const hash1 = checkpoint1.checkpoints[0]!;

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Second change.\n");
    const checkpoint2 = await Effect.runPromise(controller.createCheckpoint(checkpoint1, "c2"));

    // Rollback back to checkpoint 1
    const rolledBackTx = await Effect.runPromise(controller.rollbackToCheckpoint(checkpoint2, hash1));
    expect(rolledBackTx.checkpoints.length).toBe(1);

    const currentContent = await fs.readFile(path.join(tempDir, "initial.txt"), "utf-8");
    expect(currentContent).toBe("First change.\n");

    await Effect.runPromise(controller.abortTransaction(rolledBackTx));
  });

  it("should support committing transaction by merging changes cleanly", async () => {
    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-merge"));

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Merged changes content.\n");
    const finalTx = await Effect.runPromise(controller.createCheckpoint(tx, "ready to merge"));

    await Effect.runPromise(controller.commitTransaction(finalTx));

    // Check file content is merged in base branch
    const baseContent = await fs.readFile(path.join(tempDir, "initial.txt"), "utf-8");
    expect(baseContent).toBe("Merged changes content.\n");

    // Check ephemeral branch is deleted
    const branches = await execPromise("git branch", { cwd: tempDir });
    expect(branches.stdout.includes(tx.ephemeralBranch)).toBe(false);
  });

  it("should support applying patches cleanly", async () => {
    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-patch"));

    // Generate a standard unified diff patch
    const patchContent = `diff --git a/initial.txt b/initial.txt
--- a/initial.txt
+++ b/initial.txt
@@ -1,1 +1,1 @@
-Grug initialize codebase.
+Grug applied patch success.
`;

    await Effect.runPromise(controller.applyPatch(tx, patchContent));

    const content = await fs.readFile(path.join(tempDir, "initial.txt"), "utf-8");
    expect(content).toBe("Grug applied patch success.\n");

    await Effect.runPromise(controller.abortTransaction(tx));
  });
});

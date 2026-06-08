import * as child_process from "node:child_process";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { makeWorkspaceController } from "./WorkspaceController";
import { db } from "../../db/client";
import type { ProjectId } from "../../types";

const execPromise = promisify(exec);

describe("WorkspaceController - Git Transaction Core", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), `.grug-temp-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await execPromise("git init", { cwd: tempDir });
    await execPromise("git config user.name 'Grug Test'");
    await execPromise("git config user.email 'grug@test.com'");
    await execPromise("git config commit.gpgSign false");

    await fs.writeFile(path.join(tempDir, ".gitignore"), ".grug-active-transaction.json\n");
    await fs.writeFile(path.join(tempDir, "initial.txt"), "Grug initialize codebase.\n");
    await execPromise("git add .", { cwd: tempDir });
    await execPromise("git commit -m 'initial commit'", { cwd: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should initiate transaction only if workspace status is clean", async () => {
    const controller = makeWorkspaceController(tempDir);

    const runClean = controller.initTransaction("task-123");
    const tx = await Effect.runPromise(runClean);
    expect(tx.baseBranch).toBeDefined();
    expect(tx.ephemeralBranch).toBe("grug-task/task-123");

    await execPromise(`git checkout ${tx.baseBranch}`, { cwd: tempDir });
    await execPromise(`git branch -D ${tx.ephemeralBranch}`, { cwd: tempDir });

    await fs.writeFile(path.join(tempDir, "dirty.txt"), "Dirty untracked file.\n");

    const runDirty = controller.initTransaction("task-456");
    await expect(Effect.runPromise(runDirty)).rejects.toThrow();
  });

  it("should support creating checkpoints and returning accurate milestone lists", async () => {
    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-789"));

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Grug edit 1.\n");
    const tx2 = await Effect.runPromise(controller.createCheckpoint(tx, "edit 1"));

    expect(tx2.checkpoints.length).toBe(1);
    expect(tx2.checkpoints[0]).toBeDefined();

    await fs.writeFile(path.join(tempDir, "initial.txt"), "Grug edit 2.\n");
    const tx3 = await Effect.runPromise(controller.createCheckpoint(tx2, "edit 2"));

    expect(tx3.checkpoints.length).toBe(2);

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

    const baseContent = await fs.readFile(path.join(tempDir, "initial.txt"), "utf-8");
    expect(baseContent).toBe("Merged changes content.\n");

    const branches = await execPromise("git branch", { cwd: tempDir });
    expect(branches.stdout.includes(tx.ephemeralBranch)).toBe(false);
  });

  it("should support applying patches cleanly", async () => {
    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-patch"));

    const patchPayload = JSON.stringify({
      summary: "Apply test patch",
      files: [
        {
          file_path: "initial.txt",
          code_diff: `
<<<<<<< SEARCH
Grug initialize codebase.
=======
Grug applied patch success.
>>>>>>> REPLACE
`
        }
      ]
    });

    await Effect.runPromise(controller.applyPatch(tx, patchPayload));

    const content = await fs.readFile(path.join(tempDir, "initial.txt"), "utf-8");
    expect(content).toBe("Grug applied patch success.\n");

    await Effect.runPromise(controller.abortTransaction(tx));
  });

  it("should safely discover subdirectories and respect ignores", async () => {
    const controller = makeWorkspaceController(tempDir);

    // Populate target directories
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "src/components"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "node_modules/lodash"), { recursive: true });
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "dist"), { recursive: true });

    const listEffect = controller.listDirectories();
    const result = await Effect.runPromise(listEffect);

    expect(result).toContain("src");
    expect(result).toContain("src/components");
    expect(result).not.toContain("node_modules");
    expect(result).not.toContain("node_modules/lodash");
    expect(result).not.toContain("dist");
    expect(result).not.toContain(".git");
  });

  it("should manage `.grug-active-transaction.json` metadata lifecycle and state reconciliation correctly", async () => {
    const controller = makeWorkspaceController(tempDir);
    const stateFile = path.join(tempDir, ".grug-active-transaction.json");

    expect(fs.stat(stateFile).then(() => true).catch(() => false)).resolves.toBe(false);

    const dummyTasks = [
      { id: "task-1", description: "Write metadata logic", targetFiles: ["src/a.ts"], status: "pending" as const, developerNotes: null }
    ];
    const tx = await Effect.runPromise(controller.initTransaction("task-metadata-lifecycle", "openai", dummyTasks));

    const text1 = await fs.readFile(stateFile, "utf-8");
    const parsed1 = JSON.parse(text1);
    expect(parsed1.tx.id).toBe("task-metadata-lifecycle");
    expect(parsed1.tx.provider).toBe("openai");
    expect(parsed1.tasks.length).toBe(1);
    expect(parsed1.tasks[0].id).toBe("task-1");

    const readState1 = await Effect.runPromise(controller.readTransactionState());
    expect(readState1).not.toBeNull();
    expect(readState1?.tx.id).toBe("task-metadata-lifecycle");
    expect(readState1?.tasks[0]?.description).toBe("Write metadata logic");

    const updatedTasks = [
      { id: "task-1", description: "Write metadata logic", targetFiles: ["src/a.ts"], status: "completed" as const, developerNotes: null }
    ];
    await fs.writeFile(path.join(tempDir, "initial.txt"), "Modified.\n");
    const tx2 = await Effect.runPromise(controller.createCheckpoint(tx, "first-checkpoint", updatedTasks));

    const text2 = await fs.readFile(stateFile, "utf-8");
    const parsed2 = JSON.parse(text2);
    expect(parsed2.tx.checkpoints.length).toBe(1);
    expect(parsed2.tasks[0].status).toBe("completed");

    const tx3 = await Effect.runPromise(controller.rollbackToCheckpoint(tx2, tx2.checkpoints[0]!, updatedTasks));
    expect(tx3.checkpoints.length).toBe(1);

    await Effect.runPromise(controller.abortTransaction(tx3));
    const existsAfterAbort = await fs.stat(stateFile).then(() => true).catch(() => false);
    expect(existsAfterAbort).toBe(false);
  });

  it("should execute project-specific commands if a registered project matches root_path === cwd", async () => {
    const absoluteTempDir = path.resolve(tempDir);
    const projectId = crypto.randomUUID() as ProjectId;

    await db.insertInto("project")
      .values({
        id: projectId,
        name: "Mock Echo Project",
        root_path: absoluteTempDir,
        type_check_command: "echo typecheck-passed",
        lint_command: "echo lint-passed",
        test_command: "echo test-passed"
      })
      .execute();

    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-custom-commands"));

    const tcResult = await Effect.runPromise(controller.runTypeCheck(tx));
    expect(tcResult.success).toBe(true);

    const lcResult = await Effect.runPromise(controller.runLintCheck(tx));
    expect(lcResult.success).toBe(true);

    const tsResult = await Effect.runPromise(controller.runTestSuite(tx));
    expect(tsResult.success).toBe(true);

    await db.deleteFrom("project").where("id", "=", projectId).execute();
    await Effect.runPromise(controller.abortTransaction(tx));
  });

  it("should execute commands using startup_command if defined on matching project", async () => {
    const absoluteTempDir = path.resolve(tempDir);
    const projectId = crypto.randomUUID() as ProjectId;

    await db.insertInto("project")
      .values({
        id: projectId,
        name: "Mock Startup Command Project",
        root_path: absoluteTempDir,
        type_check_command: "-e console.log('startup-typecheck-success')",
        lint_command: "-e console.log('startup-lint-success')",
        test_command: "-e console.log('startup-test-success')",
        startup_command: "bun"
      })
      .execute();

    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-startup-command-verify"));

    const tcResult = await Effect.runPromise(controller.runTypeCheck(tx));
    expect(tcResult.success).toBe(true);

    const lcResult = await Effect.runPromise(controller.runLintCheck(tx));
    expect(lcResult.success).toBe(true);

    const tsResult = await Effect.runPromise(controller.runTestSuite(tx));
    expect(tsResult.success).toBe(true);

    await db.deleteFrom("project").where("id", "=", projectId).execute();
    await Effect.runPromise(controller.abortTransaction(tx));
  });

  it("should capture failed custom commands stdout/stderr in VerificationResult", async () => {
    const absoluteTempDir = path.resolve(tempDir);
    const projectId = crypto.randomUUID() as ProjectId;

    await db.insertInto("project")
      .values({
        id: projectId,
        name: "Failing Custom Project",
        root_path: absoluteTempDir,
        type_check_command: "bun -e console.error('typecheck-failure-details');process.exit(1)"
      })
      .execute();

    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-failing-command"));

    const result = await Effect.runPromise(controller.runTypeCheck(tx));
    expect(result.success).toBe(false);
    expect(result.errorOutput).toContain("typecheck-failure-details");

    await db.deleteFrom("project").where("id", "=", projectId).execute();
    await Effect.runPromise(controller.abortTransaction(tx));
  });

  it("should successfully create and delete background Git worktrees cleanly", async () => {
    const controller = makeWorkspaceController(tempDir);
    const tx = await Effect.runPromise(controller.initTransaction("task-worktree-ops"));

    const worktreePath = await Effect.runPromise(controller.createWorktree(tx));
    expect(worktreePath).toContain(`.cache/grug-code/worktrees/task-${tx.id}`);

    const exists = await fs.stat(worktreePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const initialTxtExists = await fs.stat(path.join(worktreePath, "initial.txt")).then(() => true).catch(() => false);
    expect(initialTxtExists).toBe(true);

    await Effect.runPromise(controller.deleteWorktree(tx));

    const existsAfterDelete = await fs.stat(worktreePath).then(() => true).catch(() => false);
    expect(existsAfterDelete).toBe(false);

    await Effect.runPromise(controller.abortTransaction(tx));
  });

  it("should reject worktree creation if path traversal in transaction ID is detected", async () => {
    const controller = makeWorkspaceController(tempDir);
    const tx = {
      id: "../../../escaped-worktree",
      baseBranch: "main",
      ephemeralBranch: "grug-task/escaped-worktree",
      checkpoints: []
    };

    const program = controller.createWorktree(tx);
    const result = await Effect.runPromise(Effect.either(program));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("Security validation failed: path traversal attempt detected");
    }
  });

  it("should reject worktree deletion if path traversal in transaction ID is detected", async () => {
    const controller = makeWorkspaceController(tempDir);
    const tx = {
      id: "../../../escaped-worktree-del",
      baseBranch: "main",
      ephemeralBranch: "grug-task/escaped-worktree-del",
      checkpoints: []
    };

    const program = controller.deleteWorktree(tx);
    const result = await Effect.runPromise(Effect.either(program));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("Security validation failed: path traversal attempt detected");
    }
  });

  describe("Tier-Based Verification Routing", () => {
    let spawnSpy: any;

    beforeEach(() => {
      spawnSpy = vi.spyOn(child_process, "spawn").mockImplementation(() => {
        const mockChild = new (require("node:events").EventEmitter)();
        (mockChild as any).stdout = new (require("node:events").EventEmitter)();
        (mockChild as any).stderr = new (require("node:events").EventEmitter)();
        setTimeout(() => {
          mockChild.emit("close", 0);
        }, 10);
        return mockChild as any;
      });
    });

    afterEach(() => {
      spawnSpy.mockRestore();
    });

    it("should route to Tier 1 (Dev Container) when uses_devcontainer is true", async () => {
      const projectId = crypto.randomUUID() as ProjectId;
      const absoluteTempDir = path.resolve(tempDir);

      await db.insertInto("project")
        .values({
          id: projectId,
          name: "DevContainer Project",
          root_path: absoluteTempDir,
          type_check_command: "tsc --noEmit",
          uses_devcontainer: true
        })
        .execute();

      const controller = makeWorkspaceController(tempDir);
      const tx = await Effect.runPromise(controller.initTransaction("task-t1"));

      const result = await Effect.runPromise(controller.runTypeCheck(tx));
      expect(result.success).toBe(true);

      expect(spawnSpy).toHaveBeenCalled();
      const firstCall = spawnSpy.mock.calls[0];
      expect(firstCall[0]).toBe("devcontainer");
      expect(firstCall[1]).toEqual([
        "exec",
        "--workspace-folder",
        absoluteTempDir,
        "tsc",
        "--noEmit"
      ]);

      await db.deleteFrom("project").where("id", "=", projectId).execute();
      await Effect.runPromise(controller.abortTransaction(tx));
    });

    it("should route to Tier 2 (Nix/Docker Sandbox) when uses_devcontainer is false, flake.nix exists, and docker is running", async () => {
      const projectId = crypto.randomUUID() as ProjectId;
      const absoluteTempDir = path.resolve(tempDir);

      await fs.writeFile(path.join(tempDir, "flake.nix"), "{}");

      await db.insertInto("project")
        .values({
          id: projectId,
          name: "Nix Docker Project",
          root_path: absoluteTempDir,
          type_check_command: "tsc --noEmit",
          uses_devcontainer: false
        })
        .execute();

      const execSyncSpy = vi.spyOn(require("node:child_process"), "execSync").mockImplementation((cmd: string) => {
        if (cmd === "docker info") return Buffer.from("Docker is running");
        return Buffer.from("");
      });

      const controller = makeWorkspaceController(tempDir);
      const tx = await Effect.runPromise(controller.initTransaction("task-t2"));

      const result = await Effect.runPromise(controller.runTypeCheck(tx));
      expect(result.success).toBe(true);

      expect(spawnSpy).toHaveBeenCalled();
      const firstCall = spawnSpy.mock.calls[0];
      expect(firstCall[0]).toBe("docker");
      expect(firstCall[1]).toEqual([
        "run",
        "--rm",
        "--network", "none",
        "-v", "/nix/store:/nix/store:ro",
        "-v", `${absoluteTempDir}:${absoluteTempDir}`,
        "-w", absoluteTempDir,
        "alpine",
        "tsc",
        "--noEmit"
      ]);

      execSyncSpy.mockRestore();
      await fs.unlink(path.join(tempDir, "flake.nix")).catch(() => {});
      await db.deleteFrom("project").where("id", "=", projectId).execute();
      await Effect.runPromise(controller.abortTransaction(tx));
    });

    it("should route to Tier 3 (Host Fallback) when no container configurations are available", async () => {
      const projectId = crypto.randomUUID() as ProjectId;
      const absoluteTempDir = path.resolve(tempDir);

      await db.insertInto("project")
        .values({
          id: projectId,
          name: "Host Project",
          root_path: absoluteTempDir,
          type_check_command: "tsc --noEmit",
          uses_devcontainer: false
        })
        .execute();

      const controller = makeWorkspaceController(tempDir);
      const tx = await Effect.runPromise(controller.initTransaction("task-t3"));

      const result = await Effect.runPromise(controller.runTypeCheck(tx));
      expect(result.success).toBe(true);

      expect(spawnSpy).toHaveBeenCalled();
      const firstCall = spawnSpy.mock.calls[0];
      expect(firstCall[0]).toBe("tsc");
      expect(firstCall[1]).toEqual(["--noEmit"]);

      await db.deleteFrom("project").where("id", "=", projectId).execute();
      await Effect.runPromise(controller.abortTransaction(tx));
    });
  });
});

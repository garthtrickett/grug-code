import { Effect } from "effect";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyDiffs } from "./AiderPatcher";
import type { PlanTask } from "../shared/ai-schemas.ts";

export interface DirtyFile {
  readonly filePath: string;
  readonly content: string;
}

export interface VerificationResult {
  readonly success: boolean;
  readonly errorOutput?: string;
  readonly dirtyFiles: readonly DirtyFile[];
}

export interface GitTransaction {
  readonly id: string;
  readonly baseBranch: string;
  readonly ephemeralBranch: string;
  readonly checkpoints: readonly string[];
  readonly provider?: "gemini" | "openai" | "deepseek";
}

export interface WorkspaceController {
  readonly initTransaction: (
    taskId: string,
    provider?: "gemini" | "openai" | "deepseek",
    initialTasks?: readonly PlanTask[]
  ) => Effect.Effect<GitTransaction, Error>;
  readonly applyPatch: (tx: GitTransaction, patch: string) => Effect.Effect<void, Error>;
  readonly runTypeCheck: (tx: GitTransaction) => Effect.Effect<VerificationResult, Error>;
  readonly runTestSuite: (tx: GitTransaction) => Effect.Effect<VerificationResult, Error>;
  readonly createCheckpoint: (
    tx: GitTransaction,
    message: string,
    tasks?: readonly PlanTask[]
  ) => Effect.Effect<GitTransaction, Error>;
  readonly rollbackToCheckpoint: (
    tx: GitTransaction,
    commitHash: string,
    tasks?: readonly PlanTask[]
  ) => Effect.Effect<GitTransaction, Error>;
  readonly commitTransaction: (tx: GitTransaction) => Effect.Effect<void, Error>;
  readonly abortTransaction: (tx: GitTransaction) => Effect.Effect<void, Error>;
  readonly listDirectories: () => Effect.Effect<readonly string[], Error>;
  readonly readTransactionState: () => Effect.Effect<{ readonly tx: GitTransaction; readonly tasks: readonly PlanTask[] } | null, Error>;
}

const runCommand = (args: string[], cwd?: string, env?: Record<string, string>) =>
  Effect.tryPromise({
    try: () => new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const [command, ...cmdArgs] = args;
      if (!command) {
        return reject(new Error("No command provided"));
      }
      const child = spawn(command, cmdArgs, { 
        cwd,
        env: { ...process.env, ...env }
      });
      let stdout = "";
      let stderr = "";
      
      child.stdout?.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) {
          stdout += chunk.toString("utf-8");
        } else if (typeof chunk === "string") {
          stdout += chunk;
        } else {
          stdout += String(chunk);
        }
      });
      child.stderr?.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) {
          stderr += chunk.toString("utf-8");
        } else if (typeof chunk === "string") {
          stderr += chunk;
        } else {
          stderr += String(chunk);
        }
      });
      child.on("close", (exitCode) => {
        resolve({ exitCode: exitCode ?? 0, stdout, stderr });
      });
      child.on("error", (err) => {
        reject(err);
      });
    }),
    catch: (error) => new Error(`Failed to execute command ${args.join(" ")}: ${String(error)}`),
  });

export const makeWorkspaceController = (cwd?: string): WorkspaceController => {
  const txFile = path.resolve(cwd || process.cwd(), ".grug-active-transaction.json");

    const updateStateFile = (tx: GitTransaction, tasks?: readonly PlanTask[]) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("[WorkspaceController] Syncing transaction state to file: " + txFile);
      let currentTasks = tasks;
      if (!currentTasks) {
        const exists = yield* Effect.tryPromise({
          try: () => fs.stat(txFile).then(() => true).catch(() => false),
          catch: (e) => new Error(`Failed to check file stat: ${String(e)}`),
        });
        if (exists) {
          const text = yield* Effect.tryPromise({
            try: () => fs.readFile(txFile, "utf-8"),
            catch: (e) => new Error(`Failed to read active transaction state file: ${String(e)}`),
          });
          try {
            const parsed = JSON.parse(text) as { tasks?: readonly PlanTask[] };
            currentTasks = parsed.tasks;
          } catch {
            // ignore parsing or file empty edge-cases
          }
        }
      }
      const state = { tx, tasks: currentTasks || [] };
      yield* Effect.tryPromise({
        try: () => fs.writeFile(txFile, JSON.stringify(state, null, 2), "utf-8"),
        catch: (e) => new Error(`Failed to write active transaction state file: ${String(e)}`),
      });
    });

    const deleteStateFile = () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("[WorkspaceController] Cleaning up state file: " + txFile);
      const exists = yield* Effect.tryPromise({
        try: () => fs.stat(txFile).then(() => true).catch(() => false),
        catch: (e) => new Error(`Failed to check file stat: ${String(e)}`),
      });
      if (exists) {
        yield* Effect.tryPromise({
          try: () => fs.unlink(txFile),
          catch: (e) => new Error(`Failed to delete active transaction state file: ${String(e)}`),
        });
      }
    });

  const getDirtyFiles = () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("[WorkspaceController] Gathering modified files for verification context...");
      const diffCmd = yield* runCommand(["git", "diff", "--name-only"], cwd);
      if (diffCmd.exitCode !== 0) {
        yield* Effect.logError(`[WorkspaceController] Git diff query failed: ${diffCmd.stderr}`);
        return [];
      }

      const files = diffCmd.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

      const dirty: DirtyFile[] = [];
      for (const file of files) {
        const filePath = cwd ? `${cwd}/${file}` : file;
        const content = yield* Effect.tryPromise({
          try: () => fs.readFile(filePath, "utf-8"),
          catch: (e) => new Error(`Failed to read file: ${String(e)}`),
        }).pipe(Effect.catchAll(() => Effect.succeed("")));
        dirty.push({ filePath: file, content });
      }
      return dirty;
    });

  return {
    initTransaction: (taskId: string, provider?: "gemini" | "openai" | "deepseek", initialTasks?: readonly PlanTask[]) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`[WorkspaceController] Initializing Git transaction for task: ${taskId} with provider: ${provider ?? "gemini"}`);

        const status = yield* runCommand(["git", "status", "--porcelain"], cwd);
        if (status.exitCode !== 0) {
          yield* Effect.logError(`[WorkspaceController] Status check failed: ${status.stderr}`);
          return yield* Effect.fail(new Error(`Failed to check workspace status: ${status.stderr}`));
        }

        if (status.stdout.trim() !== "") {
          yield* Effect.logWarning("[WorkspaceController] Aborting transaction init: unstaged/uncommitted files present.");
          return yield* Effect.fail(
            new Error("Workspace is dirty. Stage or commit your changes before starting a task.")
          );
        }

        const branchCmd = yield* runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
        if (branchCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to identify current branch: ${branchCmd.stderr}`));
        }

        const baseBranch = branchCmd.stdout.trim();
        const ephemeralBranch = `grug-task/${taskId}`;

        yield* Effect.logInfo(`[WorkspaceController] Creating ephemeral task branch: ${ephemeralBranch}`);
        const checkoutCmd = yield* runCommand(["git", "checkout", "-b", ephemeralBranch], cwd);
        if (checkoutCmd.exitCode !== 0) {
          yield* Effect.logError(`[WorkspaceController] Checkout failed: ${checkoutCmd.stderr}`);
          return yield* Effect.fail(new Error(`Failed to checkout branch ${ephemeralBranch}: ${checkoutCmd.stderr}`));
        }

        const txObj = {
          id: taskId,
          baseBranch,
          ephemeralBranch,
          checkpoints: [],
          provider,
        };

        yield* updateStateFile(txObj, initialTasks);

        return txObj;
      }),

    applyPatch: (tx: GitTransaction, patch: string) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`[WorkspaceController] Applying incoming Aider patch for transaction: ${tx.id}`);
        
        yield* applyDiffs(patch, cwd);

        yield* Effect.logInfo("[WorkspaceController] Patch applied cleanly via native AiderPatcher.");
      }),

    runTypeCheck: (_tx: GitTransaction) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("[WorkspaceController] Running TypeScript compiler verification on task branch...");
        const cmd = ["bun", "x", "tsc", "--noEmit"];
        const result = yield* runCommand(cmd, cwd);
        const success = result.exitCode === 0;
        const dirtyFiles = yield* getDirtyFiles();

        if (!success) {
          yield* Effect.logWarning("[WorkspaceController] Typecheck failures caught.");
        } else {
          yield* Effect.logInfo("[WorkspaceController] Typecheck passed successfully.");
        }

        return {
          success,
          errorOutput: success ? undefined : result.stdout + "\n" + result.stderr,
          dirtyFiles,
        };
      }),

    runTestSuite: (_tx: GitTransaction) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("[WorkspaceController] Running suite execution on task branch...");
        const cmd = ["bun", "run", "test"];
        const result = yield* runCommand(cmd, cwd, { NODE_ENV: "test" });
        const success = result.exitCode === 0;
        const dirtyFiles = yield* getDirtyFiles();

        if (!success) {
          yield* Effect.logWarning(`[WorkspaceController] Testing suites reports failure. Output:\n${result.stdout}\n${result.stderr}`);
        } else {
          yield* Effect.logInfo("[WorkspaceController] Testing suites passed successfully.");
        }

        return {
          success,
          errorOutput: success ? undefined : result.stdout + "\n" + result.stderr,
          dirtyFiles,
        };
      }),

    createCheckpoint: (tx: GitTransaction, message: string, tasks?: readonly PlanTask[]) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`[WorkspaceController] Staging workspace elements for milestone: ${message}`);
        const addCmd = yield* runCommand(["git", "add", "-A"], cwd);
        if (addCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to stage files: ${addCmd.stderr}`));
        }

        const commitMsg = `grug: checkpoint - ${message}`;
        const commitCmd = yield* runCommand(["git", "commit", "-m", commitMsg, "--allow-empty"], cwd);
        if (commitCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to commit checkpoint: ${commitCmd.stderr}`));
        }

        const revCmd = yield* runCommand(["git", "rev-parse", "HEAD"], cwd);
        if (revCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to read latest commit hash: ${revCmd.stderr}`));
        }

        const commitHash = revCmd.stdout.trim();
        yield* Effect.logInfo(`[WorkspaceController] Checkpoint created successfully. Hash: ${commitHash}`);

        const updatedTx = {
          ...tx,
          checkpoints: [...tx.checkpoints, commitHash],
        };

        yield* updateStateFile(updatedTx, tasks);

        return updatedTx;
      }),

    rollbackToCheckpoint: (tx: GitTransaction, commitHash: string, tasks?: readonly PlanTask[]) =>
      Effect.gen(function* () { 
        yield* Effect.logInfo(`[WorkspaceController] Reverting working directory to checkpoint hash: ${commitHash}`);

        if (!tx.checkpoints.includes(commitHash)) {
          return yield* Effect.fail(
            new Error(`Commit hash ${commitHash} is not a valid checkpoint for task ${tx.id}`)
          );
        }

        const resetCmd = yield* runCommand(["git", "reset", "--hard", commitHash], cwd);
        if (resetCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to reset hard: ${resetCmd.stderr}`));
        }

        const cleanCmd = yield* runCommand(["git", "clean", "-fd"], cwd);
        if (cleanCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to clean untracked: ${cleanCmd.stderr}`));
        }

        const targetIdx = tx.checkpoints.indexOf(commitHash);
        const remainingCheckpoints = tx.checkpoints.slice(0, targetIdx + 1);

        yield* Effect.logInfo("[WorkspaceController] Reverted successfully.");
        const updatedTx = {
          ...tx,
          checkpoints: remainingCheckpoints,
        };

        yield* updateStateFile(updatedTx, tasks);

        return updatedTx;
      }),

    commitTransaction: (tx: GitTransaction) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`[WorkspaceController] Committing and merging transaction: ${tx.id}`);

        const checkoutCmd = yield* runCommand(["git", "checkout", tx.baseBranch], cwd);
        if (checkoutCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to checkout base branch ${tx.baseBranch}: ${checkoutCmd.stderr}`));
        }

        const mergeCmd = yield* runCommand(
          ["git", "merge", tx.ephemeralBranch, "--no-ff", "-m", `grug: merge task ${tx.id}`],
          cwd
        );
        if (mergeCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to merge ephemeral branch: ${mergeCmd.stderr}`));
        }

        const deleteCmd = yield* runCommand(["git", "branch", "-d", tx.ephemeralBranch], cwd);
        if (deleteCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to delete task branch: ${deleteCmd.stderr}`));
        }

        yield* deleteStateFile();

        yield* Effect.logInfo("[WorkspaceController] Ephemeral transaction branch cleaned and closed.");
      }),

    abortTransaction: (tx: GitTransaction) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`[WorkspaceController] Aborting transaction: ${tx.id}`);

        yield* runCommand(["git", "reset", "--hard", "HEAD"], cwd);
        yield* runCommand(["git", "clean", "-fd"], cwd);

        const checkoutCmd = yield* runCommand(["git", "checkout", tx.baseBranch], cwd);
        if (checkoutCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to checkout base branch ${tx.baseBranch}: ${checkoutCmd.stderr}`));
        }

        const deleteCmd = yield* runCommand(["git", "branch", "-D", tx.ephemeralBranch], cwd);
        if (deleteCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to force-delete task branch: ${deleteCmd.stderr}`));
        }

        yield* deleteStateFile();

        yield* Effect.logInfo("[WorkspaceController] Ephemeral transaction branch purged safely.");
      }),

    listDirectories: () =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`[WorkspaceController] Scanning subdirectories under root: ${cwd || "process.cwd()"}`);
        const rootDir = path.resolve(cwd || process.cwd());
        const dirs: string[] = [];
        const queue: { abs: string; rel: string; depth: number }[] = [{ abs: rootDir, rel: "", depth: 0 }];
        const IGNORED_NAMES = new Set([
          "node_modules",
          "dist",
          "build",
          "out",
          "coverage",
          "android",
          "ios",
          ".git",
          ".vite",
          ".idea",
          ".vscode",
          ".venv",
          "test-results",
          "playwright-report"
        ]);

        while (queue.length > 0) {
          const current = queue.shift();
          if (!current) continue;

          const { abs, rel, depth } = current;
          if (depth > 5) continue;

          const files = yield* Effect.tryPromise({ 
            try: () => fs.readdir(abs, { withFileTypes: true }),
            catch: (e) => new Error(`Failed to read directory ${abs}: ${String(e)}`),
          });

          for (const file of files) {
            if (file.isDirectory()) {
              const name = file.name;
              if (IGNORED_NAMES.has(name) || name.startsWith(".")) {
                continue;
              }
              const nextRel = rel ? `${rel}/${name}` : name;
              const nextAbs = path.join(abs, name);

              if (!nextAbs.startsWith(rootDir)) {
                continue;
              }

              dirs.push(nextRel);
              queue.push({ abs: nextAbs, rel: nextRel, depth: depth + 1 });
            } 
          } 
        }

        dirs.sort();
        return dirs;
      }),

        readTransactionState: () =>
      Effect.gen(function* () {
        yield* Effect.logInfo("[WorkspaceController] Reading active transaction state from disk...");
        const exists = yield* Effect.tryPromise({
          try: () => fs.stat(txFile).then(() => true).catch(() => false),
          catch: (e) => new Error(`Failed to check file stat: ${String(e)}`),
        });

        if (!exists) {
          yield* Effect.logInfo("[WorkspaceController] Active transaction state file not found on disk.");
          return null;
        }

        const text = yield* Effect.tryPromise({ 
          try: () => fs.readFile(txFile, "utf-8"),
          catch: (e) => new Error(`Failed to read active transaction state file: ${String(e)}`),
        });

        let state: { tx: GitTransaction; tasks: readonly PlanTask[] };
        try {
          state = JSON.parse(text) as { tx: GitTransaction; tasks: readonly PlanTask[] };
        } catch (e) {
          yield* Effect.logError(`[WorkspaceController] Failed to parse active transaction state file: ${String(e)}`);
          return yield* Effect.fail(new Error(`Failed to parse active transaction state file: ${String(e)}`));
        }

        const branchCmd = yield* runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
        if (branchCmd.exitCode !== 0) {
          return yield* Effect.fail(new Error(`Failed to identify current branch: ${branchCmd.stderr}`));
        }

        const currentBranch = branchCmd.stdout.trim();
        if (currentBranch !== state.tx.ephemeralBranch) {
          yield* Effect.logWarning(
            `[WorkspaceController] Ephemeral branch mismatch. Git is on '${currentBranch}', but metadata expects '${state.tx.ephemeralBranch}'.`
          );
          return null;
        }

        yield* Effect.logInfo(`[WorkspaceController] Active transaction verified and parsed successfully: ${state.tx.id}`);
        return state;
      }),
  };
};;

import { signal } from "@preact/signals-core";
import { Effect } from "effect";
import { clientLog } from "../clientLog";

export interface PlanTask {
  readonly id: string;
  readonly description: string;
  readonly targetFiles: readonly string[];
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly developerNotes?: string;
}

export interface GitTransaction {
  readonly id: string;
  readonly baseBranch: string;
  readonly ephemeralBranch: string;
  readonly checkpoints: readonly string[];
}

// Client-side Signals
export const tasksSignal = signal<readonly PlanTask[]>([]);
export const isPausedSignal = signal<boolean>(false);
export const activeTxSignal = signal<GitTransaction | null>(null);
export const errorSignal = signal<string | null>(null);

export const grugTokenState = signal<string>(
  typeof localStorage !== "undefined" ? localStorage.getItem("grug-token") || "" : ""
);

export const setGrugToken = (token: string) => {
  grugTokenState.value = token;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem("grug-token", token);
  }
};

const getHeaders = () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = grugTokenState.value;
  if (token) {
    headers["X-Grug-Token"] = token;
  }
  return headers;
};

export const taskStore = {
  clear: () =>
    Effect.gen(function* () {
      tasksSignal.value = [];
      isPausedSignal.value = false;
      activeTxSignal.value = null;
      errorSignal.value = null;
    }),

  initTaskQueue: (taskId: string, description: string, targetFiles: readonly string[], cwd?: string) =>
    Effect.gen(function* () {
      errorSignal.value = null;
      yield* clientLog("info", `[taskStore] Initializing task queue for transaction: ${taskId}`);

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch("/api/workspace/init", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ taskId, cwd }),
          }),
        catch: (e) => new Error(`Failed to contact server: ${String(e)}`),
      });

      if (!response.ok) {
        const errObj = yield* Effect.tryPromise({
          try: () => response.json() as Promise<{ error: string }>,
          catch: () => ({ error: `HTTP error ${response.status}` }),
        });
        errorSignal.value = errObj.error;
        return yield* Effect.fail(new Error(errObj.error));
      }

      const tx = yield* Effect.tryPromise({
        try: () => response.json() as Promise<GitTransaction>,
        catch: (e) => new Error(`Failed to parse transaction data: ${String(e)}`),
      });

      // Populate initial tasks checklist based on targeted files
      const initialTasks: PlanTask[] = [
        {
          id: `step-analysis-${crypto.randomUUID().slice(0, 8)}`,
          description: `Analyze codebase target files: ${targetFiles.join(", ")}`,
          targetFiles,
          status: "completed",
        },
        {
          id: `step-patch-${crypto.randomUUID().slice(0, 8)}`,
          description: `Apply surgical patch changes for feature "${description}"`,
          targetFiles,
          status: "pending",
        },
        {
          id: `step-verification-${crypto.randomUUID().slice(0, 8)}`,
          description: "Verify codebase type-checking and run active unit/E2E test suite",
          targetFiles: [],
          status: "pending",
        }
      ];

      tasksSignal.value = initialTasks;
      activeTxSignal.value = tx;
      isPausedSignal.value = false;

      // Hydrate logical clocks to verify causal flows
      const { hlcStore } = yield* Effect.promise(() => import("./hlcStore"));
      yield* hlcStore.tick();

      yield* clientLog("info", `[taskStore] Task queue initialized. Ephemeral branch: ${tx.ephemeralBranch}`);
      return tx;
    }),

  pauseQueue: () =>
    Effect.gen(function* () {
      isPausedSignal.value = true;
      yield* clientLog("info", "[taskStore] Task execution queue PAUSED by developer.");
    }),

  resumeQueue: () =>
    Effect.gen(function* () {
      isPausedSignal.value = false;
      yield* clientLog("info", "[taskStore] Task execution queue RESUMED.");
    }),

  editTaskNotes: (taskId: string, notes: string) =>
    Effect.gen(function* () {
      tasksSignal.value = tasksSignal.value.map((task) =>
        task.id === taskId ? { ...task, developerNotes: notes } : task
      );
      yield* clientLog("debug", `[taskStore] Edited task notes for ${taskId}`);
    }),

  rollbackTo: (commitHash: string, cwd?: string) =>
    Effect.gen(function* () {
      errorSignal.value = null;
      const tx = activeTxSignal.value;
      if (!tx) {
        return yield* Effect.fail(new Error("No active transaction found for rollback."));
      }

      yield* clientLog("warn", `[taskStore] Initiating rollback to checkpoint hash: ${commitHash}`);

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch("/api/workspace/rollback", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ tx, commitHash, cwd }),
          }),
        catch: (e) => new Error(`Failed to contact server: ${String(e)}`),
      });

      if (!response.ok) {
        const errObj = yield* Effect.tryPromise({
          try: () => response.json() as Promise<{ error: string }>,
          catch: () => ({ error: `HTTP error ${response.status}` }),
        });
        errorSignal.value = errObj.error;
        return yield* Effect.fail(new Error(errObj.error));
      }

      const updatedTx = yield* Effect.tryPromise({
        try: () => response.json() as Promise<GitTransaction>,
        catch: (e) => new Error(`Failed to parse rollback transaction data: ${String(e)}`),
      });

      activeTxSignal.value = updatedTx;
      
      // Update tasks status: reset pending stages
      tasksSignal.value = tasksSignal.value.map((task) =>
        task.status === "completed" ? task : { ...task, status: "pending" }
      );

      yield* clientLog("info", `[taskStore] Rollback completed. Checkpoints remaining: ${updatedTx.checkpoints.length}`);
      return updatedTx;
    }),

  abortTask: (cwd?: string) =>
    Effect.gen(function* () {
      errorSignal.value = null;
      const tx = activeTxSignal.value;
      if (!tx) return;

      yield* clientLog("warn", `[taskStore] Aborting active transaction: ${tx.id}`);

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch("/api/workspace/abort", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ tx, cwd }),
          }),
        catch: (e) => new Error(`Failed to contact server: ${String(e)}`),
      });

      if (!response.ok) {
        const errObj = yield* Effect.tryPromise({
          try: () => response.json() as Promise<{ error: string }>,
          catch: () => ({ error: `HTTP error ${response.status}` }),
        });
        errorSignal.value = errObj.error;
        return yield* Effect.fail(new Error(errObj.error));
      }

      tasksSignal.value = [];
      activeTxSignal.value = null;
      isPausedSignal.value = false;

      yield* clientLog("info", "[taskStore] Active transaction aborted and local workspace reset.");
    }),

  commitTask: (cwd?: string) =>
    Effect.gen(function* () {
      errorSignal.value = null;
      const tx = activeTxSignal.value;
      if (!tx) return;

      yield* clientLog("info", `[taskStore] Committing transaction: ${tx.id}`);

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch("/api/workspace/commit", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ tx, cwd }),
          }),
        catch: (e) => new Error(`Failed to contact server: ${String(e)}`),
      });

      if (!response.ok) {
        const errObj = yield* Effect.tryPromise({
          try: () => response.json() as Promise<{ error: string }>,
          catch: () => ({ error: `HTTP error ${response.status}` }),
        });
        errorSignal.value = errObj.error;
        return yield* Effect.fail(new Error(errObj.error));
      }

      tasksSignal.value = [];
      activeTxSignal.value = null;
      isPausedSignal.value = false;

      yield* clientLog("info", "[taskStore] Active transaction committed and merged successfully.");
    }),
};

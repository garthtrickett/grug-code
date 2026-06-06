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
  readonly provider?: "gemini" | "openai" | "deepseek";
}

const getStoredTx = (): GitTransaction | null => {
  if (typeof localStorage === "undefined") return null;
  const stored = localStorage.getItem("grug-active-tx");
  if (!stored) return null;
  try {
    return JSON.parse(stored) as GitTransaction;
  } catch {
    return null;
  }
};

const getStoredTasks = (): readonly PlanTask[] => {
  if (typeof localStorage === "undefined") return [];
  const stored = localStorage.getItem("grug-active-tasks");
  if (!stored) return [];
  try {
    return JSON.parse(stored) as readonly PlanTask[];
  } catch {
    return [];
  }
};

const getStoredPaused = (): boolean => {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem("grug-active-paused") === "true";
};

// Client-side Signals (Hydrated from persistent LocalStorage cache)
export const tasksSignal = signal<readonly PlanTask[]>(getStoredTasks());
export const isPausedSignal = signal<boolean>(getStoredPaused());
export const activeTxSignal = signal<GitTransaction | null>(getStoredTx());
export const errorSignal = signal<string | null>(null);
export const stepProgressSignal = signal<string>("");

export const grugTokenState = signal<string>("");

export const isResearchingSignal = signal<boolean>(false);
export const isPlanningSignal = signal<boolean>(false);
export const proposedFilesSignal = signal<readonly string[]>([]);
export const proposedTasksSignal = signal<readonly PlanTask[]>([]);

export const discussionHistorySignal = signal<readonly { role: "user" | "assistant"; text: string }[]>([]);
export const discussionTextSignal = signal<string>("");
export const suggestedOptionsSignal = signal<readonly string[]>([]);
export const isDiscussingSignal = signal<boolean>(false);

export const initializeGrugToken = () => {
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="grug-session-token"]');
    if (meta) {
      const token = meta.getAttribute("content") || "";
      grugTokenState.value = token;
      meta.remove();
      if (token && typeof localStorage !== "undefined") {
        localStorage.setItem("grug-token", token);
      }
      console.info("[taskStore] Successfully extracted secure session token from HTML meta and scrubbed element.");
      return;
    }
  }
  if (typeof localStorage !== "undefined") {
    grugTokenState.value = localStorage.getItem("grug-token") || "";
    console.info("[taskStore] Fallback to localStorage for secure session token.");
  }
};

// Auto-run on module evaluation to guarantee hydration
initializeGrugToken();

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
      stepProgressSignal.value = "";
      isResearchingSignal.value = false;
      isPlanningSignal.value = false;
      proposedFilesSignal.value = [];
      proposedTasksSignal.value = [];
      discussionHistorySignal.value = [];
      discussionTextSignal.value = "";
      suggestedOptionsSignal.value = [];
      isDiscussingSignal.value = false;
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem("grug-active-tx");
        localStorage.removeItem("grug-active-tasks");
        localStorage.removeItem("grug-active-paused");
      }
    }),

  reconcileActiveTransaction: (cwd?: string) =>
    Effect.gen(function* () {
      errorSignal.value = null;
      yield* clientLog("info", "[taskStore] Reconciling active transaction state with server...");

      const url = cwd ? `/api/workspace/status?cwd=${encodeURIComponent(cwd)}` : "/api/workspace/status";

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "GET",
            headers: getHeaders(),
          }),
        catch: (e) => new Error(`Failed to query transaction status: ${String(e)}`),
      }).pipe(Effect.either);

      if (response._tag === "Left") {
        yield* clientLog("warn", `[taskStore] Server unreachable during reconciliation: ${response.left.message}. Using cached localStorage.`);
        return;
      }

      const res = response.right;
      if (!res.ok) {
        yield* clientLog("error", `[taskStore] Status request failed: HTTP ${res.status}`);
        return;
      }

      const state = yield* Effect.tryPromise({
        try: () => res.json() as Promise<{ tx: GitTransaction; tasks: readonly PlanTask[] } | null>,
        catch: (e) => new Error(`Failed to parse transaction status payload: ${String(e)}`),
      });

      if (state) {
        yield* clientLog("info", `[taskStore] Active transaction reconciled successfully with server: id=${state.tx.id}`);
        activeTxSignal.value = state.tx;
        tasksSignal.value = state.tasks;

        if (typeof localStorage !== "undefined") {
          localStorage.setItem("grug-active-tx", JSON.stringify(state.tx));
          localStorage.setItem("grug-active-tasks", JSON.stringify(state.tasks));
        }

        const hasPending = state.tasks.some((t) => t.status === "pending");
        if (!isPausedSignal.value && hasPending) {
          yield* clientLog("info", "[taskStore] Active pending tasks found during reconciliation. Resuming autopilot runner...");
          yield* Effect.forkDaemon(taskStore.autoRunQueue(cwd));
        }
      } else {
        yield* clientLog("info", "[taskStore] No active transaction found on server. Clearing any stale local storage states.");
        yield* taskStore.clear();
      }
    }),

  researchFeature: (
    description: string,
    cwd?: string,
    selectedScope?: string,
    provider?: "gemini" | "openai" | "deepseek",
    mode: "standard" | "discussion" = "standard",
    history?: readonly { role: "user" | "assistant"; text: string }[]
  ) =>
    Effect.gen(function* () {
      errorSignal.value = null;
      isResearchingSignal.value = true;
      
      yield* clientLog("info", `[taskStore] Researching codebase in mode: ${mode} for feature: ${description}`);

      const requestCwd = selectedScope ? (cwd ? `${cwd}/${selectedScope}` : selectedScope) : cwd;

      console.info("[taskStore DEBUG] Sending fetch to /api/workspace/research with userPrompt:", description);

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch("/api/workspace/research", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({
              userPrompt: description,
              cwd: requestCwd,
              provider,
              mode,
              history,
            }),
          }),
        catch: (e) => new Error(`Failed to contact server: ${String(e)}`),
      });

      console.info("[taskStore DEBUG] Received response from /api/workspace/research with status:", response.status);

      yield* clientLog("info", "[taskStore] POST /api/workspace/research fetch response completed", response.status);

      isResearchingSignal.value = false;

      if (!response.ok) {
        const errObj = yield* Effect.tryPromise({
          try: () => response.json() as Promise<{ error: string }>,
          catch: () => ({ error: `HTTP error ${response.status}` }),
        });
        errorSignal.value = errObj.error;
        yield* clientLog("error", "[taskStore] POST /api/workspace/research response was not OK", errObj.error);
        return yield* Effect.fail(new Error(errObj.error));
      }

      yield* clientLog("info", "[taskStore] Parsing response JSON payload...");

      const researchResult = yield* Effect.tryPromise({ 
        try: () => response.json() as Promise<{
          status: "discussion" | "resolved";
          discussionText?: string;
          suggestedOptions?: readonly string[];
          target_files?: readonly string[];
          plan?: readonly PlanTask[];
        }>,
        catch: (e) => new Error(`Failed to parse research data: ${String(e)}`),
      });

      yield* clientLog("info", "[taskStore] Parse successfully completed, updating signals...");

      if (researchResult.status === "discussion") {
        discussionTextSignal.value = researchResult.discussionText || "";
        suggestedOptionsSignal.value = researchResult.suggestedOptions || [];
        isDiscussingSignal.value = true;
        isPlanningSignal.value = false;
        if (history) {
          discussionHistorySignal.value = history;
        }
      } else {
        proposedFilesSignal.value = researchResult.target_files || [];
        proposedTasksSignal.value = researchResult.plan || [];
        isPlanningSignal.value = true;
        isDiscussingSignal.value = false;
      }

      yield* clientLog("info", `[taskStore] Research completed with status: ${researchResult.status}`);
      return researchResult;
    }),

  initTaskQueue: (
    taskId: string,
    description: string,
    targetFiles: readonly string[],
    cwd?: string,
    selectedScope?: string,
    provider?: "gemini" | "openai" | "deepseek",
    customTasks?: readonly PlanTask[]
  ) =>
    Effect.gen(function* () { 
      errorSignal.value = null;
      yield* clientLog("info", `[taskStore] Initializing task queue for transaction: ${taskId}`);

      const requestCwd = selectedScope ? (cwd ? `${cwd}/${selectedScope}` : selectedScope) : cwd;

      let initialTasks: readonly PlanTask[];
      if (customTasks && customTasks.length > 0) {
        initialTasks = customTasks;
      } else {
        initialTasks = [
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
      }

      console.info("[taskStore DEBUG] Sending fetch to /api/workspace/init with taskId:", taskId);

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch("/api/workspace/init", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ taskId, cwd: requestCwd, provider, tasks: initialTasks }),
          }),
        catch: (e) => new Error(`Failed to contact server: ${String(e)}`),
      });

      console.info("[taskStore DEBUG] Received response from /api/workspace/init with status:", response.status);

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

            tasksSignal.value = initialTasks;
      activeTxSignal.value = tx;
      isPlanningSignal.value = false;
      proposedFilesSignal.value = [];
      proposedTasksSignal.value = [];

      if (typeof localStorage !== "undefined") {
        localStorage.setItem("grug-active-tx", JSON.stringify(tx));
        localStorage.setItem("grug-active-tasks", JSON.stringify(initialTasks));
        localStorage.setItem("grug-active-paused", isPausedSignal.value ? "true" : "false");
      }

      const { hlcStore } = yield* Effect.promise(() => import("./hlcStore"));
      yield* hlcStore.tick();

      yield* clientLog("info", `[taskStore] Task queue initialized. Ephemeral branch: ${tx.ephemeralBranch}`);
      
      if (!isPausedSignal.value) {
        yield* Effect.forkDaemon(taskStore.autoRunQueue(cwd));
      }

      return tx;
    }),

  executeStep: (task: PlanTask, cwd?: string) =>
    Effect.gen(function* () {
      errorSignal.value = null;
      stepProgressSignal.value = "Applying initial instructions...";
      
      const tx = activeTxSignal.value;
      if (!tx) return;

      tasksSignal.value = tasksSignal.value.map((t) =>
        t.id === task.id 
          ? { ...t, status: "running" } 
          : t.status === "running" 
            ? { ...t, status: "pending" } 
            : t
      );
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("grug-active-tasks", JSON.stringify(tasksSignal.value));
      }

      yield* clientLog("info", `[taskStore] Executing step: ${task.description}`);

      let polling = true;
      const pollProgress = async () => {
        while (polling) {
          try {
            const res = await fetch("/api/workspace/progress", { headers: getHeaders() });
            if (res.ok) {
              const data = await res.json() as { progress: string };
              if (data.progress) {
                stepProgressSignal.value = data.progress;
              }
            }
          } catch {
            // Ignore temporary polling network drops
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      if (typeof process === "undefined" || process.env.NODE_ENV !== "test") {
        void pollProgress();
      }

      console.info("[taskStore DEBUG] Sending fetch to /api/workspace/execute-step for task:", task.id);

      const runFetch = Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch("/api/workspace/execute-step", {
              method: "POST",
              headers: getHeaders(),
              body: JSON.stringify({
                tx,
                targetFiles: task.targetFiles,
                instructions: task.developerNotes || task.description,
                cwd,
                currentTaskId: task.id,
                tasks: tasksSignal.value
              }),
            }),
          catch: (e) => new Error(`Failed to contact server: ${String(e)}`),
        });

        console.info("[taskStore DEBUG] Received response from /api/workspace/execute-step with status:", response.status);

        if (!response.ok) {
          const errObj = yield* Effect.tryPromise({
            try: () => response.json() as Promise<{ error: string }>,
            catch: () => ({ error: `HTTP error ${response.status}` }),
          });
          errorSignal.value = errObj.error;
          tasksSignal.value = tasksSignal.value.map((t) =>
            t.id === task.id ? { ...t, status: "failed" } : t
          );
          if (typeof localStorage !== "undefined") {
            localStorage.setItem("grug-active-tasks", JSON.stringify(tasksSignal.value));
          }
          return yield* Effect.fail(new Error(errObj.error));
        }

        const updatedTx = yield* Effect.tryPromise({
          try: () => response.json() as Promise<GitTransaction>,
          catch: (e) => new Error(`Failed to parse transaction data: ${String(e)}`),
        });

        activeTxSignal.value = updatedTx;
        tasksSignal.value = tasksSignal.value.map((t) =>
          t.id === task.id ? { ...t, status: "completed" } : t
        );

        if (typeof localStorage !== "undefined") {
          localStorage.setItem("grug-active-tx", JSON.stringify(updatedTx));
          localStorage.setItem("grug-active-tasks", JSON.stringify(tasksSignal.value));
        }

        yield* clientLog("info", `[taskStore] Step successfully executed: ${task.description}`);
      });

      yield* Effect.ensuring(
        runFetch,
        Effect.sync(() => {
          polling = false;
          stepProgressSignal.value = "";
        })
      );
    }),

  autoRunQueue: (cwd?: string) =>
    Effect.gen(function* () {
      while (true) {
        if (isPausedSignal.value) {
          yield* clientLog("info", "[taskStore] Auto-pilot queue runner is paused. Halting.");
          break;
        }

        const pendingTask = tasksSignal.value.find((t) => t.status === "pending");
        if (!pendingTask) {
          yield* clientLog("info", "[taskStore] No more pending tasks. Auto-pilot complete.");
          break;
        }

        yield* clientLog("info", `[taskStore] Auto-pilot runner starting next step: ${pendingTask.description}`);
        
        const stepResult = yield* Effect.either(taskStore.executeStep(pendingTask, cwd));
        if (stepResult._tag === "Left") {
          yield* clientLog("error", `[taskStore] Auto-pilot step failed: ${pendingTask.description}. Halting queue.`);
          break;
        }
      }
    }),

  pauseQueue: () =>
    Effect.gen(function* () {
      isPausedSignal.value = true;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("grug-active-paused", "true");
      }
      yield* clientLog("info", "[taskStore] Task execution queue PAUSED by developer.");
    }),

  resumeQueue: (cwd?: string) =>
    Effect.gen(function* () {
      isPausedSignal.value = false;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("grug-active-paused", "false");
      }
      yield* clientLog("info", "[taskStore] Task execution queue RESUMED.");
      
      yield* Effect.forkDaemon(taskStore.autoRunQueue(cwd));
    }),

  editTaskNotes: (taskId: string, notes: string) =>
    Effect.gen(function* () {
      tasksSignal.value = tasksSignal.value.map((task) =>
        task.id === taskId ? { ...task, developerNotes: notes } : task
      );
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("grug-active-tasks", JSON.stringify(tasksSignal.value));
      }
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
      
      tasksSignal.value = tasksSignal.value.map((task) =>
        task.status === "completed" ? task : { ...task, status: "pending" }
      );

      if (typeof localStorage !== "undefined") {
        localStorage.setItem("grug-active-tx", JSON.stringify(updatedTx));
        localStorage.setItem("grug-active-tasks", JSON.stringify(tasksSignal.value));
      }

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

      if (typeof localStorage !== "undefined") {
        localStorage.removeItem("grug-active-tx");
        localStorage.removeItem("grug-active-tasks");
        localStorage.removeItem("grug-active-paused");
      }

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

      if (typeof localStorage !== "undefined") {
        localStorage.removeItem("grug-active-tx");
        localStorage.removeItem("grug-active-tasks");
        localStorage.removeItem("grug-active-paused");
      }

      yield* clientLog("info", "[taskStore] Active transaction committed and merged successfully.");
    }),
};

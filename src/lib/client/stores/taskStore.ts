import { signal } from "@preact/signals-core";
import { Effect } from "effect";
import { clientLog } from "../clientLog";
import { McpClientService } from "../McpClientService.ts";

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

export interface ReconciledState {
  readonly tx: GitTransaction | null;
  readonly tasks: readonly PlanTask[];
}

export interface ResearchResult {
  readonly status: "discussion" | "resolved" | "exploring";
  readonly discussionText?: string;
  readonly suggestedOptions?: readonly string[];
  readonly target_files?: readonly string[];
  readonly plan?: readonly PlanTask[];
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

// Client-side Signals
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

      const mcp = yield* McpClientService;

      const response = yield* mcp.callTool("git_get_status", { cwd }).pipe(Effect.either);

      if (response._tag === "Left") {
        yield* clientLog("warn", `[taskStore] Reconcile tool call failed: ${response.left.message}. Using cached localStorage.`);
        return;
      }

      const res = response.right;
      const firstContent = res.content[0];
      const text = firstContent?.text;
      
                  let state: ReconciledState | null = null;
      if (text) {
        try {
          state = JSON.parse(text) as ReconciledState;
        } catch {
          state = null;
        }
      }

      if (state && typeof state === "object" && state.tx) {
        yield* clientLog("info", `[taskStore] Active transaction reconciled successfully via MCP: id=${state.tx.id}`);
        activeTxSignal.value = state.tx;
        tasksSignal.value = state.tasks || [];

        if (typeof localStorage !== "undefined") {
          localStorage.setItem("grug-active-tx", JSON.stringify(state.tx));
          localStorage.setItem("grug-active-tasks", JSON.stringify(state.tasks || []));
        }

        const hasPending = (state.tasks || []).some((t) => t.status === "pending");
        if (!isPausedSignal.value && hasPending) {
          yield* clientLog("info", "[taskStore] Active pending tasks found. Resuming autopilot runner...");
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
      
      yield* clientLog("info", `[taskStore] Researching codebase via MCP in mode: ${mode} for feature: ${description}`);

      const requestCwd = selectedScope ? (cwd ? `${cwd}/${selectedScope}` : selectedScope) : cwd;
      const mcp = yield* McpClientService;

      const responseResult = yield* mcp.callTool("grug_skeletal_research", {
        userPrompt: description,
        cwd: requestCwd,
        provider,
        mode,
        history,
      }).pipe(Effect.either);

      isResearchingSignal.value = false;

      if (responseResult._tag === "Left") {
        errorSignal.value = responseResult.left.message;
        yield* clientLog("error", "[taskStore] MCP grug_skeletal_research call failed", responseResult.left);
        return yield* Effect.fail(responseResult.left);
      }

            const res = responseResult.right;
      const firstContent = res.content[0];
      const text = firstContent?.text;
      if (!text) {
        errorSignal.value = "Empty response from skeletal research tool";
        return yield* Effect.fail(new Error("Empty response from skeletal research tool"));
      }

      const researchResult = (JSON.parse(text) as unknown) as ResearchResult;

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
      yield* clientLog("info", `[taskStore] Initializing task queue via MCP for transaction: ${taskId}`);

      const requestCwd = selectedScope ? (cwd ? `${cwd}/${selectedScope}` : selectedScope) : cwd;
      const mcp = yield* McpClientService;

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

      const responseResult = yield* mcp.callTool("git_init_tx", {
        taskId,
        cwd: requestCwd,
        provider,
        tasks: initialTasks,
      }).pipe(Effect.either);

      if (responseResult._tag === "Left") {
        errorSignal.value = responseResult.left.message;
        return yield* Effect.fail(responseResult.left);
      }

            const res = responseResult.right;
      const firstContent = res.content[0];
      const text = firstContent?.text;
      if (!text) {
        errorSignal.value = "Failed to parse initial transaction data";
        return yield* Effect.fail(new Error("Failed to parse initial transaction data"));
      }

      const tx = (JSON.parse(text) as unknown) as GitTransaction;

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

      yield* clientLog("info", `[taskStore] Executing step via MCP: ${task.description}`);

      const mcp = yield* McpClientService;

      const runFetch = Effect.gen(function* () { 
        const responseResult = yield* mcp.callTool("execute_step", {
          tx,
          targetFiles: task.targetFiles,
          instructions: task.developerNotes || task.description,
          cwd,
          currentTaskId: task.id,
          tasks: tasksSignal.value,
        }).pipe(Effect.either);

        if (responseResult._tag === "Left") {
          errorSignal.value = responseResult.left.message;
          yield* clientLog("error", "[taskStore] execute_step MCP call failed", responseResult.left);
          tasksSignal.value = tasksSignal.value.map((t) =>
            t.id === task.id ? { ...t, status: "failed" } : t
          );
          return yield* Effect.fail(responseResult.left);
        }

                const res = responseResult.right;
        const firstContent = res.content[0];
        const text = firstContent?.text;
        if (!text) {
          errorSignal.value = "Failed to parse updated transaction data";
          tasksSignal.value = tasksSignal.value.map((t) =>
            t.id === task.id ? { ...t, status: "failed" } : t
          );
          return yield* Effect.fail(new Error("Failed to parse updated transaction data"));
        }

        const updatedTx = (JSON.parse(text) as unknown) as GitTransaction;
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
          yield* clientLog(
            "error", 
            `[taskStore] Auto-pilot step failed: ${pendingTask.description}. Halting queue.`,
            stepResult.left
          );
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

      yield* clientLog("warn", `[taskStore] Initiating rollback via MCP to checkpoint hash: ${commitHash}`);

      const mcp = yield* McpClientService;

      const responseResult = yield* mcp.callTool("git_rollback", { tx, commitHash, cwd }).pipe(Effect.either);

      if (responseResult._tag === "Left") {
        errorSignal.value = responseResult.left.message;
        return yield* Effect.fail(responseResult.left);
      }

            const res = responseResult.right;
      const firstContent = res.content[0];
      const text = firstContent?.text;
      if (!text) {
        errorSignal.value = "Failed to parse rollback transaction data";
        return yield* Effect.fail(new Error("Failed to parse rollback transaction data"));
      }

      const updatedTx = (JSON.parse(text) as unknown) as GitTransaction;
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

      yield* clientLog("warn", `[taskStore] Aborting active transaction via MCP: ${tx.id}`);

      const mcp = yield* McpClientService;

      const responseResult = yield* mcp.callTool("git_abort", { tx, cwd }).pipe(Effect.either);

      if (responseResult._tag === "Left") {
        errorSignal.value = responseResult.left.message;
        return yield* Effect.fail(responseResult.left);
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

      yield* clientLog("info", `[taskStore] Committing transaction via MCP: ${tx.id}`);

      const mcp = yield* McpClientService;

      const responseResult = yield* mcp.callTool("git_commit", { tx, cwd }).pipe(Effect.either);

      if (responseResult._tag === "Left") {
        errorSignal.value = responseResult.left.message;
        return yield* Effect.fail(responseResult.left);
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

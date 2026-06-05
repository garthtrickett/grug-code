import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import { runClientPromise } from "../runtime";
import {
  taskStore,
  tasksSignal,
  isPausedSignal,
  activeTxSignal,
  errorSignal,
  setGrugToken,
} from "./taskStore";
import { hlcStore, hlcSignal } from "./hlcStore";

describe("taskStore - Client State Machine & Signal Coordinator", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await runClientPromise(taskStore.clear());
    await runClientPromise(hlcStore.clear());
    setGrugToken("mock-session-grug-token");
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should initialize default state correctly on clear", () => {
    expect(tasksSignal.value.length).toBe(0);
    expect(isPausedSignal.value).toBe(false);
    expect(activeTxSignal.value).toBeNull();
    expect(errorSignal.value).toBeNull();
  });

  it("should set up a task queue and branch checkouts programmatically on initTaskQueue", async () => {
    const mockTx = {
      id: "task-001",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-001",
      checkpoints: [],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTx,
    }) as any;

    const initialHlcValue = hlcSignal.peek().physical;

    const action = taskStore.initTaskQueue("task-001", "Create popup component", ["src/components/Popup.ts"]);
    const txResult = await runClientPromise(action);

    expect(txResult).toEqual(mockTx);
    expect(activeTxSignal.value).toEqual(mockTx);
    expect(isPausedSignal.value).toBe(false);
    expect(tasksSignal.value.length).toBe(3); // analysis, patch, verification
    expect(tasksSignal.value[0]?.status).toBe("completed");
    expect(tasksSignal.value[1]?.status).toBe("pending");
    expect(errorSignal.value).toBeNull();

    // Verify HLC clock ticked causal timestamp forward
    expect(hlcSignal.peek().physical).toBeGreaterThanOrEqual(initialHlcValue);
  });

  it("should format initialization payloads with subfolder scopes correctly on initTaskQueue", async () => {
    const mockTx = {
      id: "task-scoped-001",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-scoped-001",
      checkpoints: [],
    };

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTx,
    });
    global.fetch = fetchSpy as any;

    const action = taskStore.initTaskQueue(
      "task-scoped-001",
      "Create button",
      ["src/components/Button.ts"],
      "/mock/cwd",
      "src/components"
    );
    await runClientPromise(action);

    // Verify the mock fetch options are formatted properly
    expect(fetchSpy).toHaveBeenCalled();
    const fetchArgs = fetchSpy.mock.calls[0];
    expect(fetchArgs).toBeDefined();
    if (fetchArgs) {
      const url = fetchArgs[0];
      const options = fetchArgs[1] as any;
      expect(url).toBe("/api/workspace/init");
      const parsedBody = JSON.parse(options.body);
      expect(parsedBody.cwd).toBe("/mock/cwd/src/components");
      expect(parsedBody.taskId).toBe("task-scoped-001");
    }
  });

  it("should handle error messages returned from failed workspace initializations", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Workspace is dirty. Stage or commit." }),
    }) as any;

    const action = taskStore.initTaskQueue("task-failed", "Fail task", ["src/fail.ts"]);
    await expect(runClientPromise(action)).rejects.toThrow("Workspace is dirty. Stage or commit.");

    expect(errorSignal.value).toBe("Workspace is dirty. Stage or commit.");
    expect(activeTxSignal.value).toBeNull();
    expect(tasksSignal.value.length).toBe(0);
  });

  it("should pause and resume queue signals accurately", async () => {
    await runClientPromise(taskStore.pauseQueue());
    expect(isPausedSignal.value).toBe(true);

    await runClientPromise(taskStore.resumeQueue());
    expect(isPausedSignal.value).toBe(false);
  });

  it("should permit developers to edit individual task notes dynamically", async () => {
    const mockTx = {
      id: "task-edit-notes",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-edit-notes",
      checkpoints: [],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTx,
    }) as any;

    await runClientPromise(taskStore.initTaskQueue("task-edit-notes", "Edit notes test", ["src/edit.ts"]));
    const targetTaskId = tasksSignal.value[0]?.id;
    expect(targetTaskId).toBeDefined();

    if (targetTaskId) {
      await runClientPromise(taskStore.editTaskNotes(targetTaskId, "Developer custom comments"));
      expect(tasksSignal.value[0]?.developerNotes).toBe("Developer custom comments");
    }
  });

  it("should support rolling back checkpoints and resetting pending status keys", async () => {
    const initTx = {
      id: "task-rb",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-rb",
      checkpoints: ["hash-1", "hash-2"],
    };
    const rolledBackTx = {
      id: "task-rb",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-rb",
      checkpoints: ["hash-1"],
    };

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => initTx,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => rolledBackTx,
      }) as any;

    await runClientPromise(taskStore.initTaskQueue("task-rb", "Rollback spec", ["src/rb.ts"]));
    expect(activeTxSignal.value?.checkpoints.length).toBe(2);

    const rollbackAction = taskStore.rollbackTo("hash-1");
    const resultTx = await runClientPromise(rollbackAction);

    expect(resultTx.checkpoints.length).toBe(1);
    expect(activeTxSignal.value?.checkpoints.length).toBe(1);
  });

  it("should support aborting active task and clearing out signals", async () => {
    const mockTx = {
      id: "task-abort",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-abort",
      checkpoints: [],
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockTx,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      }) as any;

    await runClientPromise(taskStore.initTaskQueue("task-abort", "Abort check", ["src/abort.ts"]));
    expect(activeTxSignal.value).not.toBeNull();

    await runClientPromise(taskStore.abortTask());
    expect(activeTxSignal.value).toBeNull();
    expect(tasksSignal.value.length).toBe(0);
  });
});

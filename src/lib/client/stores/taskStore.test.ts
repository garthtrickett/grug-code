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
  initializeGrugToken,
  grugTokenState,
  isResearchingSignal,
  isPlanningSignal,
  proposedFilesSignal,
  proposedTasksSignal,
  discussionTextSignal,
  suggestedOptionsSignal,
  isDiscussingSignal,
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
    expect(isResearchingSignal.value).toBe(false);
    expect(isPlanningSignal.value).toBe(false);
    expect(proposedFilesSignal.value.length).toBe(0);
    expect(proposedTasksSignal.value.length).toBe(0);
  });

  it("should securely extract token from meta tag and scrub it from document", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "grug-session-token");
    meta.setAttribute("content", "test-handshake-token-999");
    document.head.appendChild(meta);

    initializeGrugToken();

    expect(grugTokenState.value).toBe("test-handshake-token-999");
    expect(document.querySelector('meta[name="grug-session-token"]')).toBeNull();
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

    // Pause queue initially to prevent background autopilot run during initialization assertion
    isPausedSignal.value = true;

    const action = taskStore.initTaskQueue("task-001", "Create popup component", ["src/components/Popup.ts"]);
    const txResult = await runClientPromise(action);

    expect(txResult).toEqual(mockTx);
    expect(activeTxSignal.value).toEqual(mockTx);
    expect(isPausedSignal.value).toBe(true);
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

  it("should forward provider parameter correctly to init API endpoint", async () => {
    const mockTx = {
      id: "task-provider-001",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-provider-001",
      checkpoints: [],
      provider: "openai"
    };

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTx,
    });
    global.fetch = fetchSpy as any;

    const action = taskStore.initTaskQueue(
      "task-provider-001",
      "Test OpenAI Choice",
      ["src/math.ts"],
      undefined,
      undefined,
      "openai"
    );
    await runClientPromise(action);

    expect(fetchSpy).toHaveBeenCalled();
    const options = fetchSpy.mock.calls[0]?.[1] as any;
    expect(options).toBeDefined();
    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.provider).toBe("openai");
  });

  it("should successfully trigger researchFeature and update planning signals", async () => {
    const mockResearchData = {
      target_files: ["src/services/payment.ts"],
      plan: [
        {
          id: "step-1",
          description: "Modify payment signature",
          targetFiles: ["src/services/payment.ts"],
          status: "pending" as const,
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResearchData,
    }) as any;

    const action = taskStore.researchFeature("Adjust processing", "/mock/cwd", "src", "openai");
    const result = await runClientPromise(action);

    expect(result).toEqual(mockResearchData);
    expect(isResearchingSignal.value).toBe(false);
    expect(isPlanningSignal.value).toBe(true);
    expect(proposedFilesSignal.value).toEqual(["src/services/payment.ts"]);
    expect(proposedTasksSignal.value).toEqual(mockResearchData.plan);
  });

  it("should successfully trigger researchFeature in discussion mode and update discussion signals", async () => {
    const mockDiscussionData = {
      status: "discussion",
      discussionText: "Grug wants to discuss Option A and Option B first.",
      suggestedOptions: ["Implement option A", "Implement option B"],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockDiscussionData,
    }) as any;

    const action = taskStore.researchFeature(
      "Adjust processing",
      "/mock/cwd",
      "src",
      "openai",
      "discussion",
      []
    );
    const result = await runClientPromise(action);

    expect(result).toEqual(mockDiscussionData);
    expect(isResearchingSignal.value).toBe(false);
    expect(isDiscussingSignal.value).toBe(true);
    expect(isPlanningSignal.value).toBe(false);
    expect(discussionTextSignal.value).toBe("Grug wants to discuss Option A and Option B first.");
    expect(suggestedOptionsSignal.value).toEqual(["Implement option A", "Implement option B"]);
  });

  it("should execute steps sequentially and create checkpoints automatically on autoRunQueue success", async () => {
    const initTx = {
      id: "task-autopilot-success",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-autopilot-success",
      checkpoints: [],
    };

    const step1Tx = {
      ...initTx,
      checkpoints: ["checkpoint-1"],
    };

    const step2Tx = {
      ...initTx,
      checkpoints: ["checkpoint-1", "checkpoint-2"],
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
        json: async () => step1Tx,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => step2Tx,
      }) as any;

    const customSteps = [
      {
        id: "step-1",
        description: "Autopilot step 1",
        targetFiles: ["src/a.ts"],
        status: "pending" as const,
      },
      {
        id: "step-2",
        description: "Autopilot step 2",
        targetFiles: ["src/b.ts"],
        status: "pending" as const,
      }
    ];

    // Pause queue initially to prevent background autopilot loop race conditions
    isPausedSignal.value = true;

    await runClientPromise(taskStore.initTaskQueue(
      "task-autopilot-success",
      "Test Autopilot",
      ["src/a.ts", "src/b.ts"],
      "/mock/cwd",
      undefined,
      "openai",
      customSteps
    ));

    // Resume autopilot loop manually and wait for its completion
    isPausedSignal.value = false;
    await runClientPromise(taskStore.autoRunQueue("/mock/cwd"));

    expect(tasksSignal.value[0]?.status).toBe("completed");
    expect(tasksSignal.value[1]?.status).toBe("completed");
    expect(activeTxSignal.value?.checkpoints).toEqual(["checkpoint-1", "checkpoint-2"]);
  });

  it("should halt sequential autoRunQueue immediately on step execution failure", async () => {
    const initTx = {
      id: "task-autopilot-fail",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-autopilot-fail",
      checkpoints: [],
    };

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => initTx,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "Compilation error TS2322" }),
      }) as any;

    const customSteps = [
      {
        id: "step-1",
        description: "Autopilot failing step 1",
        targetFiles: ["src/a.ts"],
        status: "pending" as const,
      },
      {
        id: "step-2",
        description: "Autopilot step 2",
        targetFiles: ["src/b.ts"],
        status: "pending" as const,
      }
    ];

    // Pause queue initially to prevent background autopilot loop race conditions
    isPausedSignal.value = true;

    await runClientPromise(taskStore.initTaskQueue(
      "task-autopilot-fail",
      "Test Autopilot Fail",
      ["src/a.ts", "src/b.ts"],
      "/mock/cwd",
      undefined,
      "openai",
      customSteps
    ));

    // Resume autopilot loop manually and wait for its failure
    isPausedSignal.value = false;
    await runClientPromise(taskStore.autoRunQueue("/mock/cwd"));

    expect(tasksSignal.value[0]?.status).toBe("failed");
    expect(tasksSignal.value[1]?.status).toBe("pending"); // Stays pending, loop halted
    expect(errorSignal.value).toBe("Compilation error TS2322");
  });

    it("should initialize task queue with custom planned steps when provided", async () => { 
    const mockTx = {
      id: "task-002",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-002",
      checkpoints: [],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTx,
    }) as any;

    const customSteps = [
      {
        id: "step-custom-1",
        description: "Custom step description",
        targetFiles: ["src/custom.ts"],
        status: "pending" as const,
      }
    ];

    // Pause queue initially to prevent background autopilot run during assertion
    isPausedSignal.value = true;

    const action = taskStore.initTaskQueue(
      "task-002",
      "Create widget",
      ["src/custom.ts"],
      "/mock/cwd",
      undefined,
      "openai",
      customSteps
    );
    await runClientPromise(action);

    expect(activeTxSignal.value).toEqual(mockTx);
    expect(tasksSignal.value).toEqual(customSteps);
    expect(isPlanningSignal.value).toBe(false);
    expect(proposedFilesSignal.value.length).toBe(0);
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

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "task-resume" }),
    }) as any;

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

    // Pause queue to prevent background run during notes edit assertion
    isPausedSignal.value = true;

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

    // Pause queue initially to prevent background autopilot run during testing
    isPausedSignal.value = true;

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

    // Pause queue initially to prevent background autopilot run during testing
    isPausedSignal.value = true;

    await runClientPromise(taskStore.initTaskQueue("task-abort", "Abort check", ["src/abort.ts"]));
    expect(activeTxSignal.value).not.toBeNull();

    await runClientPromise(taskStore.abortTask());
    expect(activeTxSignal.value).toBeNull();
    expect(tasksSignal.value.length).toBe(0);
  });

  it("should reconcile active transaction state on boot and auto-resume execution", async () => {
    const mockState = {
      tx: {
        id: "task-reconciled-999",
        baseBranch: "main",
        ephemeralBranch: "grug-task/task-reconciled-999",
        checkpoints: ["hash-rec-1"],
      },
      tasks: [
        {
          id: "task-rec-step-1",
          description: "Step 1 completed",
          targetFiles: ["src/a.ts"],
          status: "completed" as const,
        },
        {
          id: "task-rec-step-2",
          description: "Step 2 pending",
          targetFiles: ["src/b.ts"],
          status: "pending" as const,
        }
      ],
    };

    tasksSignal.value = [
      {
        id: "task-rec-step-1",
        description: "Step 1 completed",
        targetFiles: ["src/a.ts"],
        status: "running" as const,
      },
      {
        id: "task-rec-step-2",
        description: "Step 2 pending",
        targetFiles: ["src/b.ts"],
        status: "pending" as const,
      }
    ];

    activeTxSignal.value = {
      id: "task-reconciled-999",
      baseBranch: "main",
      ephemeralBranch: "grug-task/task-reconciled-999",
      checkpoints: [],
    };

    isPausedSignal.value = false;

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/workspace/status")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockState,
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...mockState.tx, checkpoints: ["hash-rec-1", "hash-rec-2"] }),
      });
    });
    global.fetch = fetchSpy as any;

    const action = taskStore.reconcileActiveTransaction("/mock/cwd");
    await runClientPromise(action);

        expect(activeTxSignal.value?.id).toBe("task-reconciled-999");
    expect(activeTxSignal.value?.checkpoints).toEqual(["hash-rec-1"]);
    
    expect(tasksSignal.value[0]?.status).toBe("completed");

    // Wait for the background queue to complete
    for (let i = 0; i < 20; i++) {
      if (tasksSignal.value[1]?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(tasksSignal.value[1]?.status).toBe("completed");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("should clear stale local transaction state when status returns null", async () => {
    tasksSignal.value = [
      {
        id: "stale-task",
        description: "Some stale task",
        targetFiles: [],
        status: "pending" as const,
      }
    ];
    activeTxSignal.value = {
      id: "stale-tx",
      baseBranch: "main",
      ephemeralBranch: "grug-task/stale-tx",
      checkpoints: [],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => null,
    }) as any;

    const action = taskStore.reconcileActiveTransaction();
    await runClientPromise(action);

    expect(activeTxSignal.value).toBeNull();
    expect(tasksSignal.value.length).toBe(0);
  });
});

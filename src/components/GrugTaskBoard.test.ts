// @vitest-environment jsdom
// @ts-ignore
import { JSDOM } from "jsdom";
import * as nodeCrypto from "node:crypto";

if (typeof globalThis.document === "undefined") {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost",
  });
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).customElements = dom.window.customElements;
  (globalThis as any).CustomEvent = dom.window.CustomEvent;
  (globalThis as any).navigator = dom.window.navigator;
}

if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.randomUUID) {
  (globalThis as any).crypto = nodeCrypto;
}

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GrugTaskBoard - Lit Component & UI Renderer", () => {
  let element: any;
  let taskStore: any;
  let tasksSignal: any;
  let isPausedSignal: any;
  let activeTxSignal: any;
  let runClientPromise: any;

  let isResearchingSignal: any;
  let isPlanningSignal: any;
  let proposedFilesSignal: any;
  let proposedTasksSignal: any;

  let discussionHistorySignal: any;
  let discussionTextSignal: any;
  let suggestedOptionsSignal: any;
  let isDiscussingSignal: any;

  beforeAll(async () => {
    const storeMod = await import("../lib/client/stores/taskStore");
    taskStore = storeMod.taskStore;
    tasksSignal = storeMod.tasksSignal;
    isPausedSignal = storeMod.isPausedSignal;
    activeTxSignal = storeMod.activeTxSignal;
    isResearchingSignal = storeMod.isResearchingSignal;
    isPlanningSignal = storeMod.isPlanningSignal;
    proposedFilesSignal = storeMod.proposedFilesSignal;
    proposedTasksSignal = storeMod.proposedTasksSignal;
    discussionHistorySignal = storeMod.discussionHistorySignal;
    discussionTextSignal = storeMod.discussionTextSignal;
    suggestedOptionsSignal = storeMod.suggestedOptionsSignal;
    isDiscussingSignal = storeMod.isDiscussingSignal;

    const runtimeMod = await import("../lib/client/runtime");
    runClientPromise = runtimeMod.runClientPromise;

    await import("./GrugTaskBoard");
  });

    beforeEach(async () => {
    await runClientPromise(taskStore.clear());
    const projMod = await import("../lib/client/stores/projectStore");
    await runClientPromise(projMod.projectStore.clear());
    element = document.createElement("grug-task-board");
    document.body.appendChild(element);
    await tick();
  });

  it("should render the AI provider select dropdown inside launch form", async () => {
    await element.updateComplete;
    await tick();

    const providerSelect = element.querySelector("select[name='provider']") as HTMLSelectElement;
    expect(providerSelect).not.toBeNull();
    
    const options = Array.from(providerSelect.querySelectorAll("option")).map(o => o.value);
    expect(options).toContain("gemini");
    expect(options).toContain("openai");

    providerSelect.value = "openai";
    providerSelect.dispatchEvent(new Event("change"));
    expect(providerSelect.value).toBe("openai");
  });

  it("should no longer present targetFiles input text field inside launch form", async () => {
    await element.updateComplete;
    await tick();

    const targetFilesInput = element.querySelector("input[name='targetFiles']");
    expect(targetFilesInput).toBeNull();
  });

  it("should display loading study panel when isResearchingSignal is active", async () => {
    isResearchingSignal.value = true;
    await element.updateComplete;
    await tick();

    const studyHeader = element.querySelector("h2") as any;
    expect(studyHeader?.textContent || "").toContain("Grug studying codebase");

    isResearchingSignal.value = false;
  });

  it("should display target file checkboxes and steps when isPlanningSignal is active", async () => {
    isPlanningSignal.value = true;
    proposedFilesSignal.value = ["src/a.ts", "src/b.ts"];
    proposedTasksSignal.value = [
      {
        id: "task-proposed-1",
        description: "Perform a study step",
        targetFiles: ["src/a.ts"],
        status: "pending",
      }
    ];

    await element.updateComplete;
    await tick();

    const proposedHeader = element.querySelector("h2") as any;
    expect(proposedHeader?.textContent || "").toContain("Proposed Development Plan");

    const checkboxes = Array.from(element.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
    expect(checkboxes.length).toBe(2);

    const stepDescription = element.querySelector("h4") as any;
    expect(stepDescription?.textContent || "").toContain("Perform a study step");

    expect(checkboxes[0]?.checked).toBe(true);
    checkboxes[0]?.click();
    expect(checkboxes[0]?.checked).toBe(false);

    isPlanningSignal.value = false;
    proposedFilesSignal.value = [];
    proposedTasksSignal.value = [];
  });

  it("should trigger initTaskQueue with modified file selections and custom steps on click approve", async () => {
    isPlanningSignal.value = true;
    proposedFilesSignal.value = ["src/a.ts", "src/b.ts"];
    proposedTasksSignal.value = [
      {
        id: "task-proposed-1",
        description: "Planned Step",
        targetFiles: ["src/a.ts"],
        status: "pending",
      }
    ];

    await element.updateComplete;
    await tick();

    const checkboxes = Array.from(element.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
    checkboxes[1]?.click(); 

    const approveSpy = vi.spyOn(taskStore, "initTaskQueue");

    const approveBtn = Array.from(element.querySelectorAll("button")).find(
      (b: any) => b.textContent?.trim() === "Approve & Start Task Transaction"
    ) as HTMLButtonElement;
    
    expect(approveBtn).toBeDefined();
    approveBtn?.click();

    expect(approveSpy).toHaveBeenCalledWith(
      expect.stringContaining("-"),
      expect.any(String),
      ["src/a.ts"],
      undefined,
      expect.any(String),
      expect.any(String),
      proposedTasksSignal.value
    );

    isPlanningSignal.value = false;
    proposedFilesSignal.value = [];
    proposedTasksSignal.value = [];
  });

  it("should render discussion board elements when isDiscussingSignal is active", async () => {
    isDiscussingSignal.value = true;
    discussionTextSignal.value = "Grug is thinking.";
    suggestedOptionsSignal.value = ["Option X", "Option Y"];
    discussionHistorySignal.value = [
      { role: "user", text: "Hello Grug" },
      { role: "assistant", text: "Hello User" }
    ];

    await element.updateComplete;
    await tick();

    const discussionHeader = element.querySelector("h2") as any;
    expect(discussionHeader?.textContent || "").toContain("Grug Code Discussion");

    const historyTexts = Array.from(element.querySelectorAll("p")).map((p: any) => p.textContent || "");
    expect(historyTexts.some(t => t.includes("Hello Grug"))).toBe(true);
    expect(historyTexts.some(t => t.includes("Grug is thinking."))).toBe(true);

    const buttons = Array.from(element.querySelectorAll("button")).map((b: any) => b.textContent?.trim() || "");
    expect(buttons).toContain("Option X");
    expect(buttons).toContain("Option Y");

    isDiscussingSignal.value = false;
    discussionTextSignal.value = "";
    suggestedOptionsSignal.value = [];
    discussionHistorySignal.value = [];
  });

  afterEach(() => {
    if (element) {
      element.remove();
    }
  });

  it("should render the initialization form when activeTxSignal is null", async () => {
    await element.updateComplete;
    await tick();
    
    const heading = element.querySelector("h2") as any;
    expect(heading?.textContent || "").toContain("Launch Development Session");

    const form = element.querySelector("form");
    expect(form).not.toBeNull();
  });

  it("should render the directory scope dropdown when activeTxSignal is null and project is active", async () => {
    const dMod = await import("../lib/client/stores/directoryStore");
    const pMod = await import("../lib/client/stores/projectStore");
    
    dMod.directoriesSignal.value = ["apps/web", "packages/core"];
    pMod.activeProjectSignal.value = {
      id: "p-test",
      name: "Test",
      root_path: "/test",
      type_check_command: null,
      lint_command: null,
      test_command: null
    };

    await element.updateComplete;
    await tick();

    const selectLabel = Array.from(element.querySelectorAll("label")).find(
      (el: any) => el.textContent?.trim().includes("Workspace Scope")
    );
    expect(selectLabel).toBeDefined();

    const triggerBtn = element.querySelector("button[id='directory-scope-select-trigger']");
    expect(triggerBtn).not.toBeNull();
  });

  it("should render the project selector dropdown and configure button when activeTxSignal is null", async () => {
    const projMod = await import("../lib/client/stores/projectStore");
    projMod.projectsSignal.value = [
      {
        id: "p-mock-1",
        name: "Mock Website API",
        root_path: "/workspace/mock-website-api",
        type_check_command: null,
        lint_command: null,
        test_command: null,
      }
    ];

    await element.updateComplete;
    await tick();

    const triggerBtn = element.querySelector("button[id='project-select-api-trigger']");
    expect(triggerBtn).not.toBeNull();
    expect(triggerBtn?.textContent).toContain("Select Registered Project");

    const configBtn = Array.from(element.querySelectorAll("button")).find(
      (b: any) => b.textContent?.trim().includes("Configure Projects")
    ) as HTMLButtonElement;
    expect(configBtn).toBeDefined();
  });

  it("should render the active task queue checklist when activeTxSignal is populated", async () => {
    activeTxSignal.value = {
      id: "test-render-tx",
      baseBranch: "main",
      ephemeralBranch: "grug-task/test-render-tx",
      checkpoints: ["hash-100", "hash-200"],
    };

    tasksSignal.value = [
      {
        id: "task-1",
        description: "Task 1 description",
        targetFiles: ["src/a.ts"],
        status: "completed",
      },
      {
        id: "task-2",
        description: "Task 2 description",
        targetFiles: ["src/b.ts"],
        status: "pending",
      }
    ];

    await element.updateComplete;
    await tick();

    const heading = element.querySelector("h2") as any;
    expect(heading?.textContent || "").toContain("Workspace Transaction: test-render-tx");

    const stepHeaders = Array.from(element.querySelectorAll("h4")) as any[];
    expect(stepHeaders.length).toBe(2);
    expect(stepHeaders[0]?.textContent).toBe("Task 1 description");
    expect(stepHeaders[1]?.textContent).toBe("Task 2 description");

    const checkpoints = (Array.from(element.querySelectorAll("span")) as any[]).map((s) => s.textContent || "");
    expect(checkpoints.some((c) => c.includes("hash-100"))).toBe(true);
    expect(checkpoints.some((c) => c.includes("hash-200"))).toBe(true);
  });

  it("should call taskStore pause/resume queue actions upon play/pause clicks", async () => {
    activeTxSignal.value = {
      id: "test-pause-tx",
      baseBranch: "main",
      ephemeralBranch: "grug-task/test-pause-tx",
      checkpoints: [],
    };
    isPausedSignal.value = false;

    await element.updateComplete;
    await tick();

    const pauseButton = (Array.from(element.querySelectorAll("button")) as any[]).find(
      (b) => b.textContent?.trim() === "Pause Queue"
    );
    expect(pauseButton).toBeDefined();

    const pauseSpy = vi.spyOn(taskStore, "pauseQueue");
    pauseButton?.click();

    expect(pauseSpy).toHaveBeenCalled();
  });

  it("should permit removing pending tasks from list on clicking remove button", async () => {
    activeTxSignal.value = {
      id: "test-remove-tx",
      baseBranch: "main",
      ephemeralBranch: "grug-task/test-remove-tx",
      checkpoints: [],
    };
    tasksSignal.value = [
      {
        id: "task-removable",
        description: "This task can be removed",
        targetFiles: [],
        status: "pending",
      }
    ];

    await element.updateComplete;
    await tick();

    const removeBtn = (Array.from(element.querySelectorAll("button")) as any[]).find(
      (b: any) => b.textContent?.trim() === "Remove"
    );
    expect(removeBtn).toBeDefined();

    removeBtn?.click();

    expect(tasksSignal.value.length).toBe(0);
  });
});

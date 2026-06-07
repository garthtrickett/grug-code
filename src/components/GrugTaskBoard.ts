import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { effect } from "@preact/signals-core";
import { Effect } from "effect";
import * as select from "@zag-js/select";
import { VanillaMachine, normalizeProps } from "@zag-js/vanilla";
import { runClientUnscoped } from "../lib/client/runtime";
import { clientLog } from "../lib/client/clientLog";
import {
  taskStore,
  tasksSignal,
  isPausedSignal,
  activeTxSignal,
  errorSignal,
  stepProgressSignal,
  isResearchingSignal,
  isPlanningSignal,
  proposedFilesSignal,
  proposedTasksSignal,
  discussionHistorySignal,
  discussionTextSignal,
  suggestedOptionsSignal,
  isDiscussingSignal,
  type PlanTask,
} from "../lib/client/stores/taskStore";
import {
  directoriesSignal,
  selectedScopeSignal,
  fetchWorkspaceDirectories,
  createDirectorySelectMachine,
} from "../lib/client/stores/directoryStore.ts";
import {
  projectsSignal,
  activeProjectSignal,
  projectStore,
  createProjectSelectMachine,
} from "../lib/client/stores/projectStore.ts";

@customElement("grug-task-board")
export class GrugTaskBoard extends LitElement {
  private _disposeEffect?: () => void;
  private _selectService: ReturnType<typeof createDirectorySelectMachine> | null = null;
  private _projectSelectService: ReturnType<typeof createProjectSelectMachine> | null = null;
  private _checkedFiles = new Set<string>();
  private _description = "";
  private _provider: "gemini" | "openai" | "deepseek" = "gemini";
  @state() private _discussionMode = false;
  @state() private _showConfig = false;
  @state() private _editProjId: string | null = null;

  protected override createRenderRoot() {
    return this; 
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "");
  }

  override connectedCallback() {
    super.connectedCallback();

    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    runClientUnscoped(fetchWorkspaceDirectories(cwd));
    runClientUnscoped(projectStore.fetchProjects());

    this._disposeEffect = effect(() => {
      void tasksSignal.value;
      void isPausedSignal.value;
      void activeTxSignal.value;
      void errorSignal.value;
      void stepProgressSignal.value;
      void directoriesSignal.value;
      void selectedScopeSignal.value;
      void isResearchingSignal.value;
      void isPlanningSignal.value;
      void proposedFilesSignal.value;
      void proposedTasksSignal.value;
      void discussionHistorySignal.value;
      void discussionTextSignal.value;
      void suggestedOptionsSignal.value;
      void isDiscussingSignal.value;
      void projectsSignal.value;
      void activeProjectSignal.value;

      const files = proposedFilesSignal.value;
      if (isPlanningSignal.value && this._checkedFiles.size === 0) {
        files.forEach((f) => this._checkedFiles.add(f));
      } else if (!isPlanningSignal.value) {
        this._checkedFiles.clear();
      }

      this.requestUpdate();
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._disposeEffect?.();
  }

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err && typeof err === "object" && "message" in err) {
      return String((err as Record<string, unknown>).message);
    }
    return String(err);
  }

  private _toggleDiscussionMode = (e: Event) => {
    this._discussionMode = (e.target as HTMLInputElement).checked;
  };

  private handleInitSubmit = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    this._description = (form.elements.namedItem("description") as HTMLInputElement).value;
    this._provider = (form.elements.namedItem("provider") as HTMLSelectElement).value as "gemini" | "openai" | "deepseek";
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    const description = this._description;
    const provider = this._provider;
    const mode = this._discussionMode ? "discussion" : "standard";

    runClientUnscoped(
      Effect.gen(function* () {
        yield* taskStore.researchFeature(description, cwd, selectedScopeSignal.value, provider, mode, []);
      }).pipe(
        Effect.catchAll((err) =>
          clientLog("error", `[GrugTaskBoard] Failed to research feature: ${this.getErrorMessage(err)}`)
        )
      )
    );
  };

  private handleSendDiscussionReply = (text: string) => {
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    const provider = this._provider;
    const description = this._description;

    const currentHistory = [
      ...discussionHistorySignal.value,
      { role: "user" as const, text: `User request/response: "${description}"` },
      { role: "assistant" as const, text: discussionTextSignal.value },
      { role: "user" as const, text }
    ];

    runClientUnscoped(
      Effect.gen(function* () {
        yield* taskStore.researchFeature(description, cwd, selectedScopeSignal.value, provider, "discussion", currentHistory);
      }).pipe(
        Effect.catchAll((err) =>
          clientLog("error", `[GrugTaskBoard] Failed to send discussion reply: ${this.getErrorMessage(err)}`)
        )
      )
    );
  };

  private handleCustomDiscussionSubmit = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const input = form.elements.namedItem("replyText") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    this.handleSendDiscussionReply(text);
  };

  private handleToggleFile(file: string) {
    if (this._checkedFiles.has(file)) {
      this._checkedFiles.delete(file);
    } else {
      this._checkedFiles.add(file);
    }
    this.requestUpdate();
  }

  private handleConfirmProposal = () => {
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    const selectedFiles = Array.from(this._checkedFiles);
    const taskId = `${this.slugify(this._description.substring(0, 30))}-${crypto.randomUUID().slice(0, 8)}`;
    const description = this._description;
    const provider = this._provider;

    runClientUnscoped(
      Effect.gen(function* () {
        yield* taskStore.initTaskQueue(
          taskId,
          description,
          selectedFiles,
          cwd,
          selectedScopeSignal.value,
          provider,
          proposedTasksSignal.value
        );
      }).pipe(
        Effect.catchAll((err) =>
          clientLog("error", `[GrugTaskBoard] Failed to start transaction: ${this.getErrorMessage(err)}`)
        )
      )
    );
  };

  private handleCancelProposal = () => {
    runClientUnscoped(taskStore.clear());
  };

  private handleEditNotes = (taskId: string, e: Event) => {
    const input = e.target as HTMLInputElement;
    runClientUnscoped(taskStore.editTaskNotes(taskId, input.value));
  };

  private handlePauseToggle = () => {
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    if (isPausedSignal.value) {
      runClientUnscoped(taskStore.resumeQueue(cwd));
    } else {
      runClientUnscoped(taskStore.pauseQueue());
    }
  };

  private handleExecuteStep = (task: PlanTask) => {
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    runClientUnscoped(
      Effect.gen(function* () {
        yield* taskStore.executeStep(task, cwd);
      }).pipe(
        Effect.catchAll((err) =>
          clientLog("error", `[GrugTaskBoard] Step execution failed: ${this.getErrorMessage(err)}`)
        )
      )
    );
  };

  private handleRollback = (commitHash: string) => {
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    runClientUnscoped(
      Effect.gen(function* () {
        yield* taskStore.rollbackTo(commitHash, cwd);
      }).pipe(
        Effect.catchAll((err) =>
          clientLog("error", `[GrugTaskBoard] Rollback operation failed: ${this.getErrorMessage(err)}`)
        )
      )
    );
  };

  private handleAbort = () => {
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    runClientUnscoped(
      Effect.gen(function* () {
        yield* taskStore.abortTask(cwd);
      }).pipe(
        Effect.catchAll((err) =>
          clientLog("error", `[GrugTaskBoard] Abort task operation failed: ${this.getErrorMessage(err)}`)
        )
      )
    );
  };

  private handleCommit = () => {
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    runClientUnscoped(
      Effect.gen(function* () {
        yield* taskStore.commitTask(cwd);
      }).pipe(
        Effect.catchAll((err) =>
          clientLog("error", `[GrugTaskBoard] Commit task operation failed: ${this.getErrorMessage(err)}`)
        )
      )
    );
  };

  private handleRemoveTask = (taskId: string) => {
    tasksSignal.value = tasksSignal.value.filter((t) => t.id !== taskId);
    void runClientUnscoped(clientLog("info", `[GrugTaskBoard] Removed step ${taskId} from pending queue`));
  };

  private getSelectApi() {
    const items = directoriesSignal.value;
    const itemsWithRoot = ["", ...items];

    if (!this._selectService) {
      const collection = select.collection({
        items: itemsWithRoot,
        itemToString: (item) => item || "Whole Project Root",
        itemToValue: (item) => item,
      });

            const service = new VanillaMachine(select.machine, {
        id: "directory-scope-select",
        ids: {
          trigger: "directory-scope-select-trigger",
          label: "directory-scope-select-label",
          content: "directory-scope-select-content",
        },
        collection,
        value: selectedScopeSignal.value ? [selectedScopeSignal.value] : [],
        onValueChange(details: select.ValueChangeDetails<string>) {
          selectedScopeSignal.value = details.value[0] || "";
        },
      });

      this._selectService = service;
      service.start();

      service.subscribe(() => {
        this.requestUpdate();
      });
    } else {
      const collection = select.collection({
        items: itemsWithRoot,
        itemToString: (item) => item || "Whole Project Root",
        itemToValue: (item) => item,
      });
      if (this._selectService && this._selectService.updateProps) {
        this._selectService.updateProps({ collection });
      }
    }

    return select.connect(this._selectService.service, normalizeProps);
  }

  private renderSelect() {
    const api = this.getSelectApi();
    const directories = ["", ...directoriesSignal.value];

    return html`
      <div class="space-y-1 relative" id=${api.getRootProps().id}>
        <label class="text-xs font-semibold text-zinc-400 uppercase tracking-wider block" id=${api.getLabelProps().id}>
          Workspace Scope / Subdirectory
        </label>
        <div class="relative">
          <button
            type="button"
            id=${api.getTriggerProps().id}
            role="combobox"
            aria-expanded=${api.getTriggerProps()["aria-expanded"]}
            aria-controls=${api.getTriggerProps()["aria-controls"]}
            @click=${() => {
              if (api.open) {
                api.setOpen(false);
              } else {
                api.setOpen(true);
              }
            }}
            class="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 text-sm focus:outline-none focus:border-zinc-650 cursor-pointer"
          >
            <span>${selectedScopeSignal.value || "Whole Project Root"}</span>
            <span class="text-zinc-500 text-xs">▼</span>
          </button>
        </div>

        ${api.open
          ? html`
              <ul
                id=${api.getContentProps().id}
                role="listbox"
                class="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded border border-zinc-850 bg-zinc-950 py-1 shadow-lg text-sm text-zinc-200"
              >
                ${directories.map((dir) => {
                  const optionProps = api.getItemProps({ item: dir });
                  const isSelected = selectedScopeSignal.value === dir;
                  return html`
                    <li
                      id=${optionProps.id}
                      role="option"
                      aria-selected=${isSelected}
                      @click=${() => {
                        selectedScopeSignal.value = dir;
                        api.setOpen(false);
                      }}
                      class="relative cursor-pointer select-none py-2 px-3 hover:bg-zinc-900 transition-colors ${isSelected ? "bg-zinc-900 font-semibold text-white" : ""}"
                    >
                      ${dir || "Whole Project Root"}
                    </li>
                  `;
                })}
              </ul>
            `
          : ""}
      </div>
    `;
  }

  private getProjectSelectApi() {
    const projects = projectsSignal.value;

    if (!this._projectSelectService) {
      const collection = select.collection({
        items: [...projects],
        itemToString: (item) => item ? `${item.name} (${item.root_path})` : "Select Project",
        itemToValue: (item) => item ? item.id : "",
      });

            const service = new VanillaMachine(select.machine, {
        id: "project-select-api",
        ids: {
          trigger: "project-select-api-trigger",
          label: "project-select-api-label",
          content: "project-select-api-content",
        },
        collection,
        value: activeProjectSignal.value ? [activeProjectSignal.value.id] : [],
        onValueChange(details: select.ValueChangeDetails<string>) {
          const selectedId = details.value[0] || "";
          const found = projectsSignal.value.find((p) => p.id === selectedId);
          runClientUnscoped(projectStore.selectProject(found || null));
        },
      });

      this._projectSelectService = service;
      service.start();

      service.subscribe(() => {
        this.requestUpdate();
      });
    } else {
      const collection = select.collection({
        items: [...projects],
        itemToString: (item) => item ? `${item.name} (${item.root_path})` : "Select Project",
        itemToValue: (item) => item ? item.id : "",
      });
      if (this._projectSelectService && this._projectSelectService.updateProps) {
        this._projectSelectService.updateProps({ collection });
      }
    }

    return select.connect(this._projectSelectService.service, normalizeProps);
  }

  private renderProjectSelect() {
    const api = this.getProjectSelectApi();
    const projects = projectsSignal.value;

    return html`
      <div class="space-y-1 relative" id=${api.getRootProps().id}>
        <label class="text-xs font-semibold text-zinc-400 uppercase tracking-wider block" id=${api.getLabelProps().id}>
          Active Project Workspace
        </label>
        <div class="flex gap-2">
          <div class="relative flex-1">
            <button
              type="button"
              id=${api.getTriggerProps().id}
              role="combobox"
              @click=${() => {
                if (api.open) {
                  api.setOpen(false);
                } else {
                  api.setOpen(true);
                }
              }}
              class="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 text-sm focus:outline-none focus:border-zinc-650 cursor-pointer animate-fade-in"
            >
              <span>${activeProjectSignal.value ? `${activeProjectSignal.value.name} (${activeProjectSignal.value.root_path})` : "Select Registered Project"}</span>
              <span class="text-zinc-500 text-xs">▼</span>
            </button>
          </div>

          <button
            type="button"
            @click=${() => { this._showConfig = !this._showConfig; this.requestUpdate(); }}
            class="px-4 py-2.5 bg-zinc-850 hover:bg-zinc-800 text-white rounded text-xs font-bold transition-all cursor-pointer shrink-0"
          >
            ${this._showConfig ? "Close Config" : "Configure Projects"}
          </button>
        </div>

        ${api.open
          ? html`
              <ul
                id=${api.getContentProps().id}
                role="listbox"
                class="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded border border-zinc-850 bg-zinc-950 py-1 shadow-lg text-sm text-zinc-200"
              >
                ${projects.map((proj) => {
                  const isSelected = activeProjectSignal.value?.id === proj.id;
                  return html`
                    <li
                      role="option"
                      aria-selected=${isSelected}
                      @click=${() => {
                        runClientUnscoped(projectStore.selectProject(proj));
                        api.setOpen(false);
                      }}
                      class="relative cursor-pointer select-none py-2 px-3 hover:bg-zinc-900 transition-colors ${isSelected ? "bg-zinc-900 font-semibold text-white" : ""}"
                    >
                      ${proj.name} (${proj.root_path})
                    </li>
                  `;
                })}
              </ul>
            `
          : ""}
      </div>
    `;
  }

  private renderProjectConfig() {
    if (!this._showConfig) return "";

    const projects = projectsSignal.value;

    return html`
      <div class="p-6 bg-zinc-900/50 border border-zinc-800 rounded-lg space-y-6 animate-fade-in">
        <div class="flex items-center justify-between border-b border-zinc-850 pb-3">
          <h3 class="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Project Registry Settings</h3>
          <button
            type="button"
            @click=${() => { this._editProjId = "new"; this.requestUpdate(); }}
            class="px-3 py-1 bg-green-700 hover:bg-green-600 text-white rounded text-xs font-bold transition-all cursor-pointer"
          >
            + Add Project
          </button>
        </div>

        ${this._editProjId
          ? this.renderProjectForm()
          : html`
              <div class="space-y-3">
                ${projects.length === 0
                  ? html`<p class="text-xs text-zinc-400 italic">No projects registered. Click "Add Project" to begin.</p>`
                  : projects.map((proj) => html`
                      <div class="flex items-center justify-between p-3 bg-zinc-950 border border-zinc-850 rounded-lg text-sm">
                        <div class="space-y-1">
                          <h4 class="font-semibold text-white">${proj.name}</h4>
                          <p class="text-xs text-zinc-400 font-mono">CWD: ${proj.root_path}</p>
                          ${proj.type_check_command || proj.lint_command || proj.test_command
                            ? html`
                                <p class="text-[10px] text-zinc-500 font-mono">
                                  ${proj.type_check_command ? `TC: ${proj.type_check_command} | ` : ""}
                                  ${proj.lint_command ? `Lint: ${proj.lint_command} | ` : ""}
                                  ${proj.test_command ? `Test: ${proj.test_command}` : ""}
                                </p>
                              `
                            : ""}
                        </div>
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            @click=${() => { this._editProjId = proj.id; this.requestUpdate(); }}
                            class="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-xs font-bold transition-all cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            @click=${() => this.handleDeleteProject(proj.id)}
                            class="px-2.5 py-1 bg-red-900/40 hover:bg-red-900 text-red-300 rounded text-xs font-bold transition-all cursor-pointer"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    `)}
              </div>
            `}
      </div>
    `;
  }

  private renderProjectForm() {
    const isNew = this._editProjId === "new";
    const proj = projectsSignal.value.find((p) => p.id === this._editProjId);

    return html`
      <form @submit=${this.handleProjectFormSubmit} class="space-y-4 bg-zinc-950 p-4 border border-zinc-850 rounded-lg animate-fade-in">
        <h4 class="text-xs font-bold text-zinc-300 uppercase tracking-wider">
          ${isNew ? "Register New Project" : `Edit Project: ${proj?.name}`}
        </h4>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block">Project Name</label>
            <input
              name="name"
              type="text"
              required
              .value=${proj?.name || ""}
              placeholder="e.g. My Website API"
              class="w-full px-3 py-2 bg-zinc-900 border border-zinc-850 rounded text-zinc-100 text-xs focus:outline-none focus:border-zinc-700"
            />
          </div>

          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block">Root Folder Path (CWD)</label>
            <input
              name="root_path"
              type="text"
              required
              .value=${proj?.root_path || ""}
              placeholder="e.g. /workspace/projects/website-api"
              class="w-full px-3 py-2 bg-zinc-900 border border-zinc-850 rounded text-zinc-100 text-xs focus:outline-none focus:border-zinc-700"
            />
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block">Type Check Command</label>
            <input
              name="type_check_command"
              type="text"
              .value=${proj?.type_check_command || ""}
              placeholder="e.g. tsc --noEmit"
              class="w-full px-3 py-2 bg-zinc-900 border border-zinc-850 rounded text-zinc-100 text-xs focus:outline-none focus:border-zinc-700"
            />
          </div>

          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block">Lint Command</label>
            <input
              name="lint_command"
              type="text"
              .value=${proj?.lint_command || ""}
              placeholder="e.g. eslint . --fix"
              class="w-full px-3 py-2 bg-zinc-900 border border-zinc-850 rounded text-zinc-100 text-xs focus:outline-none focus:border-zinc-700"
            />
          </div>

          <div class="space-y-1">
            <label class="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block">Test Command</label>
            <input
              name="test_command"
              type="text"
              .value=${proj?.test_command || ""}
              placeholder="e.g. vitest run"
              class="w-full px-3 py-2 bg-zinc-900 border border-zinc-850 rounded text-zinc-100 text-xs focus:outline-none focus:border-zinc-700"
            />
          </div>
        </div>

        <div class="flex items-center gap-2 pt-2 border-t border-zinc-850">
          <button
            type="submit"
            class="px-4 py-2 bg-green-700 hover:bg-green-600 text-white rounded text-xs font-bold transition-all cursor-pointer"
          >
            ${isNew ? "Register Project" : "Save Updates"}
          </button>
          <button
            type="button"
            @click=${() => { this._editProjId = null; this.requestUpdate(); }}
            class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-bold transition-all cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </form>
    `;
  }

    private handleProjectFormSubmit = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const name = (form.elements.namedItem("name") as HTMLInputElement).value;
    const root_path = (form.elements.namedItem("root_path") as HTMLInputElement).value;
    const type_check_command = (form.elements.namedItem("type_check_command") as HTMLInputElement).value || null;
    const lint_command = (form.elements.namedItem("lint_command") as HTMLInputElement).value || null;
    const test_command = (form.elements.namedItem("test_command") as HTMLInputElement).value || null;

    const data = { name, root_path, type_check_command, lint_command, test_command };
    const editProjId = this._editProjId;
    const getErrorMessage = (err: unknown) => this.getErrorMessage(err);
    
    const finalize = () => {
      this._editProjId = null;
      this.requestUpdate();
    };

    runClientUnscoped(
      Effect.gen(function* () {
        if (editProjId === "new") {
          yield* projectStore.createProject(data);
        } else if (editProjId) {
          yield* projectStore.updateProject(editProjId, data);
        }
        yield* Effect.sync(finalize);
      }).pipe(
        Effect.catchAll((err) =>
          clientLog("error", `[GrugTaskBoard] Failed to save project registration: ${getErrorMessage(err)}`)
        )
      )
    );
  };

  private handleDeleteProject(id: string) {
    if (confirm("Are you sure you want to delete this project registration?")) {
      runClientUnscoped(projectStore.deleteProject(id));
    }
  }

  override render() { 
    const tx = activeTxSignal.value;
    const error = errorSignal.value;
    const tasks = tasksSignal.value;
    const isPaused = isPausedSignal.value;
    const isResearching = isResearchingSignal.value;
    const isPlanning = isPlanningSignal.value;

    return html`
      <div class="max-w-4xl mx-auto space-y-6">
        <!-- Error Alert -->
        ${error
          ? html`
              <div class="p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg text-sm text-center animate-fade-in">
                ⚠️ ${error}
              </div>
            `
          : ""}

        ${tx === null
          ? isResearching
            ? html`
                <!-- Researching Loading Indicator -->
                <div class="bg-zinc-950 border border-zinc-800 p-8 rounded-lg shadow-md space-y-6 text-center animate-pulse">
                  <div class="space-y-3">
                    <div class="text-4xl">🔍</div>
                    <h2 class="text-xl font-bold text-white tracking-tight">Grug studying codebase...</h2>
                    <p class="text-sm text-zinc-400">Scanning repository files, analyzing dependency graphs, and building implementation plan.</p>
                  </div>
                  <div class="max-w-md mx-auto bg-zinc-900 h-2 rounded-full overflow-hidden">
                    <div class="bg-zinc-100 h-full w-2/3 rounded-full animate-pulse"></div>
                  </div>
                </div>
              `
            : isDiscussingSignal.value
              ? html`
                  <!-- Discussion Board -->
                  <div class="bg-zinc-950 border border-zinc-800 p-8 rounded-lg shadow-md space-y-6">
                    <div class="space-y-2 text-center border-b border-zinc-900 pb-4">
                      <h2 class="text-xl font-bold text-white tracking-tight flex items-center justify-center gap-2">
                        <span>💬</span> Grug Code Discussion
                      </h2>
                      <p class="text-sm text-zinc-400">Let's discuss and analyze technical options before committing to code changes.</p>
                    </div>

                    <!-- Discussion logs -->
                    <div class="space-y-4 max-h-[400px] overflow-y-auto pr-2">
                      ${discussionHistorySignal.value.map((turn) => html`
                        <div class="flex flex-col gap-1 text-sm ${turn.role === "user" ? "items-end" : "items-start"}">
                          <span class="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                            ${turn.role === "user" ? "User" : "Grug"}
                          </span>
                          <div class="max-w-[85%] p-3 rounded-lg border text-zinc-200 ${turn.role === "user" ? "bg-zinc-900/60 border-zinc-800 text-right" : "bg-zinc-950 border-zinc-850"}">
                            <p class="whitespace-pre-wrap">${turn.text}</p>
                          </div>
                        </div>
                      `)}

                      <!-- Current turn analysis -->
                      <div class="flex flex-col gap-1 text-sm items-start">
                        <span class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Grug</span>
                        <div class="max-w-[85%] p-4 rounded-lg bg-zinc-900/30 border border-zinc-800 text-zinc-100">
                          <p class="whitespace-pre-wrap leading-relaxed">${discussionTextSignal.value}</p>
                        </div>
                      </div>
                    </div>

                    <!-- Suggested options -->
                    ${suggestedOptionsSignal.value.length > 0
                      ? html`
                          <div class="space-y-2">
                            <span class="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">Suggested Responses</span>
                            <div class="flex flex-wrap gap-2">
                              ${suggestedOptionsSignal.value.map((option) => html`
                                <button
                                  @click=${() => this.handleSendDiscussionReply(option)}
                                  class="px-4 py-2 bg-zinc-900 hover:bg-zinc-850 hover:text-white border border-zinc-800 text-zinc-300 font-medium rounded text-xs transition-all cursor-pointer"
                                >
                                  ${option}
                                </button>
                              `)}
                            </div>
                          </div>
                        `
                      : ""}

                    <!-- Reply input form -->
                    <form @submit=${this.handleCustomDiscussionSubmit} class="flex items-center gap-3 pt-4 border-t border-zinc-900">
                      <input
                        name="replyText"
                        type="text"
                        required
                        placeholder="Type your response or ask Grug a question..."
                        class="flex-1 px-4 py-2.5 bg-zinc-900 border border-zinc-850 rounded text-zinc-100 focus:outline-none focus:border-zinc-650 text-sm"
                      />
                      <button
                        type="submit"
                        class="px-5 py-2.5 bg-zinc-100 hover:bg-white text-zinc-900 font-bold rounded text-sm transition-colors cursor-pointer"
                      >
                        Reply
                      </button>
                      <button
                        type="button"
                        @click=${this.handleCancelProposal}
                        class="px-4 py-2.5 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-zinc-300 font-semibold rounded text-sm transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </form>
                  </div>
                `
            : isPlanning
              ? html`
                  <!-- Proposed Plan / Confirmation Board -->
                  <div class="bg-zinc-950 border border-zinc-800 p-8 rounded-lg shadow-md space-y-6">
                    <div class="space-y-2 text-center">
                      <h2 class="text-xl font-bold text-white tracking-tight">Proposed Development Plan</h2>
                      <p class="text-sm text-zinc-400">Grug studied repository targets and drafted an implementation sequence.</p>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <!-- Target Files checklist -->
                      <div class="space-y-3">
                        <h3 class="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Target Files Selection</h3>
                        <div class="border border-zinc-800 bg-zinc-900/50 rounded-lg p-4 space-y-2 max-h-80 overflow-y-auto">
                          ${proposedFilesSignal.value.length === 0
                            ? html`<p class="text-xs text-zinc-400 italic">No candidate files identified.</p>`
                            : proposedFilesSignal.value.map((file) => {
                                const isChecked = this._checkedFiles.has(file);
                                return html`
                                  <label class="flex items-center gap-3 cursor-pointer text-sm text-zinc-200 hover:text-white transition-colors py-1">
                                    <input
                                      type="checkbox"
                                      .checked=${isChecked}
                                      @change=${() => this.handleToggleFile(file)}
                                      class="rounded bg-zinc-900 border-zinc-800 text-zinc-100 focus:ring-0 focus:ring-offset-0 h-4 w-4"
                                    />
                                    <span class="font-mono text-xs break-all">${file}</span>
                                  </label>
                                `;
                              })}
                        </div>
                      </div>

                      <!-- Custom planned steps checklist preview -->
                      <div class="space-y-3">
                        <h3 class="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Proposed Implementation Steps</h3>
                        <div class="border border-zinc-800 bg-zinc-900/50 rounded-lg p-4 space-y-3 max-h-80 overflow-y-auto">
                          ${proposedTasksSignal.value.length === 0
                            ? html`<p class="text-xs text-zinc-400 italic">No custom tasks mapped by AI.</p>`
                            : proposedTasksSignal.value.map((task, index) => html`
                                <div class="flex items-start gap-3 text-xs">
                                  <span class="bg-zinc-800 text-zinc-400 h-5 w-5 rounded-full flex items-center justify-center font-bold shrink-0">${index + 1}</span>
                                  <div class="space-y-0.5">
                                    <h4 class="font-medium text-white">${task.description}</h4>
                                    <p class="text-zinc-500 font-mono text-[10px]">Targets: ${task.targetFiles.join(", ") || "none"}</p>
                                  </div>
                                </div>
                              `)}
                        </div>
                      </div>
                    </div>

                    <div class="flex items-center gap-4 pt-4 border-t border-zinc-900">
                      <button
                        @click=${this.handleConfirmProposal}
                        class="flex-1 py-2.5 bg-zinc-100 hover:bg-white text-zinc-900 font-bold rounded text-sm transition-colors cursor-pointer"
                      >
                        Approve & Start Task Transaction
                      </button>
                      <button
                        @click=${this.handleCancelProposal}
                        class="px-6 py-2.5 bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-zinc-300 font-semibold rounded text-sm transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                `
              : html`
                  <!-- Task Initialization Form -->
                  <div class="bg-zinc-950 border border-zinc-800 p-8 rounded-lg shadow-md space-y-6">
                    <div class="space-y-2 text-center">
                      <h2 class="text-xl font-bold text-white tracking-tight">Launch Development Session</h2>
                      <p class="text-sm text-zinc-400">Initialize a transactional workspace environment to begin coding feature updates.</p>
                    </div>

                    <form @submit=${this.handleInitSubmit} class="space-y-4">
                      <!-- Step 5 Active Project Workspace Selector -->
                      ${this.renderProjectSelect()}

                      <!-- Expandable Config Panel -->
                      ${this.renderProjectConfig()}

                      <!-- Zag.js Workspace Directory Scoping -->
                      ${activeProjectSignal.value 
                        ? this.renderSelect() 
                        : html`<p class="text-xs text-zinc-400 italic bg-zinc-900/30 p-3 border border-zinc-850 rounded">⚠️ Please select or configure an Active Project Workspace first to enable subfolder scoping and task execution.</p>`
                      }

                      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="space-y-1">
                          <label for="provider" class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">AI Model Provider</label>
                          <select 
                            id="provider" 
                            name="provider" 
                            class="w-full px-3 py-2.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-zinc-650 text-sm cursor-pointer"
                          >
                            <option value="deepseek">Deepseek V4 flash (Default) </option>
                            <option value="gemini">Google Gemini </option>
                            <option value="openai">OpenAI (GPT-4o)</option>
                          </select>
                        </div>

                        <div class="space-y-1">
                          <label for="description" class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Feature Description</label>
                          <input 
                            id="description" 
                            name="description" 
                            type="text" 
                            required 
                            placeholder="e.g. Fix memory leak inside Postgres client pooling during heavy load scenarios" 
                            class="w-full px-3 py-2 bg-zinc-900 border border-zinc-850 rounded text-zinc-100 focus:outline-none focus:border-zinc-650 text-sm"
                          />
                        </div>
                      </div>

                      <div class="flex items-center gap-2">
                        <label class="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" .checked=${this._discussionMode} @change=${this._toggleDiscussionMode} class="rounded bg-zinc-900 border-zinc-800 text-zinc-100 focus:ring-0 focus:ring-offset-0 h-4 w-4" />
                          <span class="text-sm text-zinc-300">Discussion Mode</span>
                        </label>
                      </div>

                      <button 
                        type="submit" 
                        ?disabled=${!activeProjectSignal.value}
                        class="w-full py-2.5 bg-zinc-100 hover:bg-white text-zinc-900 font-bold rounded text-sm transition-colors cursor-pointer disabled:bg-zinc-800 disabled:text-zinc-550 disabled:cursor-not-allowed"
                      >
                        Analyze Feature & Auto-Target
                      </button>
                    </form>
                  </div>
                `
          : html`
              <!-- Active Plan Queue & Checklist -->
              <div class="bg-zinc-950 border border-zinc-800 p-6 rounded-lg shadow-md space-y-6">
                <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
                  <div>
                    <h2 class="text-lg font-bold text-white tracking-tight">Workspace Transaction: ${tx.id}</h2>
                    <p class="text-xs text-zinc-400 mt-0.5">
                      Base: <span class="font-mono text-zinc-300 bg-zinc-900 px-1.5 py-0.5 rounded">${tx.baseBranch}</span> 
                      &rarr; Ephemeral Branch: <span class="font-mono text-zinc-300 bg-zinc-900 px-1.5 py-0.5 rounded">${tx.ephemeralBranch}</span>
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <button 
                      @click=${this.handlePauseToggle}
                      class="px-4 py-1.5 rounded text-xs font-bold transition-colors cursor-pointer ${isPaused ? "bg-green-600 hover:bg-green-500 text-white" : "bg-yellow-600 hover:bg-yellow-500 text-white"}"
                    >
                      ${isPaused ? "Resume Queue" : "Pause Queue"}
                    </button>
                    <button 
                      @click=${this.handleCommit}
                      class="px-4 py-1.5 bg-green-700 hover:bg-green-600 text-white rounded text-xs font-bold transition-colors cursor-pointer"
                    >
                      Commit Task
                    </button>
                    <button 
                      @click=${this.handleAbort}
                      class="px-4 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-bold transition-colors cursor-pointer"
                    >
                      Abort Task
                    </button>
                  </div>
                </div>

                <!-- Plan Checklist -->
                <div class="space-y-3">
                  <h3 class="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Planned Steps Checklist</h3>
                  <div class="divide-y divide-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                    ${tasks.map((task) => {
                      const isCompleted = task.status === "completed";
                      return html`
                        <div class="flex items-start justify-between gap-4 p-4 bg-zinc-950 hover:bg-zinc-900/50 transition-colors">
                          <div class="flex items-start gap-3 flex-1 min-w-0">
                            <span class="text-lg mt-0.5 shrink-0">
                              ${isCompleted ? "✅" : task.status === "running" ? "⏳" : "💤"}
                            </span>
                            <div class="flex-1 min-w-0 space-y-2">
                              <div>
                                <h4 class="text-sm font-medium text-white ${isCompleted ? "line-through text-zinc-500" : ""}">${task.description}</h4>
                                <p class="text-xs text-zinc-400 mt-0.5 font-mono">Target Files: ${task.targetFiles.join(", ") || "None"}</p>
                                ${task.status === "running" && stepProgressSignal.value
                                  ? html`<p class="text-xs text-green-400 mt-1 font-semibold animate-pulse">⏳ ${stepProgressSignal.value}</p>`
                                  : ""}
                              </div>
                              <input 
                                type="text" 
                                .value=${task.developerNotes || ""}
                                ?disabled=${isCompleted || task.status === "running"}
                                placeholder="Add developer checklist notes or instructions..."
                                @change=${(e: Event) => this.handleEditNotes(task.id, e)}
                                class="w-full px-2.5 py-1 bg-zinc-900 border border-zinc-800 rounded text-zinc-200 focus:outline-none focus:border-zinc-700 text-xs"
                              />
                            </div>
                          </div>
                          ${task.status === "pending"
                            ? html`
                                <div class="flex items-center gap-2">
                                  <button
                                    @click=${() => this.handleExecuteStep(task)}
                                    class="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-xs font-bold transition-all cursor-pointer"
                                  >
                                    Run Step
                                  </button>
                                  <button 
                                    @click=${() => this.handleRemoveTask(task.id)}
                                    class="text-zinc-500 hover:text-red-400 hover:bg-red-500/10 p-1.5 rounded transition-all cursor-pointer text-xs"
                                  >
                                    Remove
                                  </button>
                                </div>
                              `
                            : ""}
                        </div>
                      `;
                    })}
                  </div>
                </div>

                <!-- Checkpoints / Milestones -->
                <div class="space-y-3 pt-4 border-t border-zinc-800">
                  <h3 class="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Git Transaction Checkpoints (Hard Reset / Rollback)</h3>
                  ${tx.checkpoints.length === 0
                    ? html`<p class="text-xs text-zinc-400 italic">No milestones saved yet. Run active steps to checkpoint your workspace.</p>`
                    : html`
                        <div class="space-y-2">
                          ${tx.checkpoints.map((hash, index) => html`
                            <div class="flex items-center justify-between p-3 bg-zinc-900 border border-zinc-800 rounded-lg text-xs font-mono">
                              <div class="flex items-center gap-3">
                                <span class="font-bold text-zinc-500">Node #${index + 1}</span>
                                <span class="text-zinc-300 bg-zinc-950 px-2 py-0.5 rounded">${hash.substring(0, 10)}...</span>
                              </div>
                              <button 
                                @click=${() => this.handleRollback(hash)}
                                class="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded font-sans font-bold transition-all cursor-pointer"
                              >
                                Rollback Here
                              </button>
                            </div>
                          `)}
                        </div>
                      `}
                </div>
              </div>
            `}
      </div>
    `;
  }
}

import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
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
} from "../lib/client/stores/taskStore";
import {
  directoriesSignal,
  selectedScopeSignal,
  fetchWorkspaceDirectories,
} from "../lib/client/stores/directoryStore.ts";

@customElement("grug-task-board")
export class GrugTaskBoard extends LitElement {
  private _disposeEffect?: () => void;
    private _selectService: VanillaMachine<select.Context, select.State, select.Event> | null = null;

  protected override createRenderRoot() {
    return this; // Render in Light DOM to inherit Tailwind styles
  }

  override connectedCallback() {
    super.connectedCallback();

    // Load available directories for scoping
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;
    runClientUnscoped(fetchWorkspaceDirectories(cwd));

    this._disposeEffect = effect(() => {
      void tasksSignal.value;
      void isPausedSignal.value;
      void activeTxSignal.value;
      void errorSignal.value;
      void directoriesSignal.value;
      void selectedScopeSignal.value;
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

  private handleInitSubmit = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const taskId = (form.elements.namedItem("taskId") as HTMLInputElement).value;
    const description = (form.elements.namedItem("description") as HTMLInputElement).value;
    const targetFilesRaw = (form.elements.namedItem("targetFiles") as HTMLInputElement).value;
    const targetFiles = targetFilesRaw.split(",").map((f) => f.trim()).filter(Boolean);
    const cwd = typeof localStorage !== "undefined" ? localStorage.getItem("grug-cwd") || undefined : undefined;

    runClientUnscoped(
      Effect.gen(function* () {
        yield* taskStore.initTaskQueue(taskId, description, targetFiles, cwd, selectedScopeSignal.value);
      }).pipe(
        Effect.catchAll((err) =>
          clientLog("error", `[GrugTaskBoard] Failed to start task queue: ${this.getErrorMessage(err)}`)
        )
      )
    );
  };

  private handleEditNotes = (taskId: string, e: Event) => {
    const input = e.target as HTMLInputElement;
    runClientUnscoped(taskStore.editTaskNotes(taskId, input.value));
  };

  private handlePauseToggle = () => {
    if (isPausedSignal.value) {
      runClientUnscoped(taskStore.resumeQueue());
    } else {
      runClientUnscoped(taskStore.pauseQueue());
    }
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

            this._selectService = new VanillaMachine(select.machine, {
        id: "directory-scope-select",
        collection,
        value: selectedScopeSignal.value ? [selectedScopeSignal.value] : [],
        onValueChange(details: select.ValueChangeDetails<string>) {
          selectedScopeSignal.value = details.value[0] || "";
        },
      });

      this._selectService.start();

      this._selectService.subscribe(() => {
        this.requestUpdate();
      });
    } else {
      const collection = select.collection({
        items: itemsWithRoot,
        itemToString: (item) => item || "Whole Project Root",
        itemToValue: (item) => item,
      });
      if (this._selectService.setContext) {
        this._selectService.setContext({ collection });
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

  override render() {
    const tx = activeTxSignal.value;
    const error = errorSignal.value;
    const tasks = tasksSignal.value;
    const isPaused = isPausedSignal.value;

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
          ? html`
              <!-- Task Initialization Form -->
              <div class="bg-zinc-950 border border-zinc-800 p-8 rounded-lg shadow-md space-y-6">
                <div class="space-y-2 text-center">
                  <h2 class="text-xl font-bold text-white tracking-tight">Launch Development Session</h2>
                  <p class="text-sm text-zinc-400">Initialize a transactional workspace environment to begin coding feature updates.</p>
                </div>

                <form @submit=${this.handleInitSubmit} class="space-y-4">
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="space-y-1">
                      <label for="taskId" class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Task ID</label>
                      <input 
                        id="taskId" 
                        name="taskId" 
                        type="text" 
                        required 
                        placeholder="e.g. payment-reconciliation-bug" 
                        class="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-zinc-600 text-sm font-mono"
                      />
                    </div>
                    <div class="space-y-1">
                      <label for="targetFiles" class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Target Files (Comma Separated)</label>
                      <input 
                        id="targetFiles" 
                        name="targetFiles" 
                        type="text" 
                        required 
                        placeholder="e.g. src/db/client.ts, src/server/index.ts" 
                        class="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-zinc-600 text-sm font-mono"
                      />
                    </div>
                  </div>

                  <!-- Zag.js Workspace Directory Scoping -->
                  ${this.renderSelect()}

                  <div class="space-y-1">
                    <label for="description" class="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Feature Description</label>
                    <input 
                      id="description" 
                      name="description" 
                      type="text" 
                      required 
                      placeholder="e.g. Fix memory leak inside Postgres client pooling during heavy load scenarios" 
                      class="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 focus:outline-none focus:border-zinc-600 text-sm"
                    />
                  </div>

                  <button 
                    type="submit" 
                    class="w-full py-2.5 bg-zinc-100 hover:bg-white text-zinc-900 font-bold rounded text-sm transition-colors cursor-pointer"
                  >
                    Start Task Transaction
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
                              </div>
                              <input 
                                type="text" 
                                .value=${task.developerNotes || ""}
                                ?disabled=${isCompleted}
                                placeholder="Add developer checklist notes or instructions..."
                                @change=${(e: Event) => this.handleEditNotes(task.id, e)}
                                class="w-full px-2.5 py-1 bg-zinc-900 border border-zinc-800 rounded text-zinc-200 focus:outline-none focus:border-zinc-700 text-xs"
                              />
                            </div>
                          </div>
                          ${task.status === "pending"
                            ? html`
                                <button 
                                  @click=${() => this.handleRemoveTask(task.id)}
                                  class="text-zinc-500 hover:text-red-400 hover:bg-red-500/10 p-1.5 rounded transition-all cursor-pointer text-xs"
                                >
                                  Remove
                                </button>
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

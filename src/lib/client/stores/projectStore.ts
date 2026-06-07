import { signal } from "@preact/signals-core";
import { Effect } from "effect";
import * as select from "@zag-js/select";
import { VanillaMachine } from "@zag-js/vanilla";
import { clientLog } from "../clientLog";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly root_path: string;
  readonly type_check_command: string | null;
  readonly lint_command: string | null;
  readonly test_command: string | null;
}

export const projectsSignal = signal<readonly Project[]>([]);
export const activeProjectSignal = signal<Project | null>(null);

const getHeaders = () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = localStorage.getItem("grug-token");
  if (token) {
    headers["X-Grug-Token"] = token;
  }
  return headers;
};

export const projectStore = {
  fetchProjects: () =>
    Effect.gen(function* () {
      yield* clientLog("info", "[projectStore] Fetching registered projects...");
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch("/api/projects", {
            method: "GET",
            headers: getHeaders(),
          }),
        catch: (e) => new Error(`Failed to fetch projects: ${String(e)}`),
      });

      if (!response.ok) {
        return yield* Effect.fail(new Error(`Failed to fetch projects: HTTP ${response.status}`));
      }

      const data = yield* Effect.tryPromise({
        try: () => response.json() as Promise<readonly Project[]>,
        catch: (e) => new Error(`Failed to parse projects data: ${String(e)}`),
      });

      projectsSignal.value = data;

      const cachedCwd = localStorage.getItem("grug-cwd");
      if (cachedCwd) {
        const found = data.find((p) => p.root_path === cachedCwd);
        if (found) {
          activeProjectSignal.value = found;
        }
      }

      yield* clientLog("debug", `[projectStore] Loaded ${data.length} projects.`);
      return data;
    }),

  createProject: (data: Omit<Project, "id">) =>
    Effect.gen(function* () {
      yield* clientLog("info", `[projectStore] Creating project: ${data.name}`);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch("/api/projects", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify(data),
          }),
        catch: (e) => new Error(`Failed to create project: ${String(e)}`),
      });

      if (!response.ok) {
        const errObj = yield* Effect.tryPromise({
          try: () => response.json() as Promise<{ error: string }>,
          catch: () => ({ error: `HTTP ${response.status}` }),
        });
        return yield* Effect.fail(new Error(errObj.error));
      }

      const created = yield* Effect.tryPromise({
        try: () => response.json() as Promise<Project>,
        catch: (e) => new Error(`Failed to parse created project: ${String(e)}`),
      });

      projectsSignal.value = [...projectsSignal.peek(), created];
      yield* projectStore.selectProject(created);
      return created;
    }),

  updateProject: (id: string, data: Omit<Project, "id">) =>
    Effect.gen(function* () {
      yield* clientLog("info", `[projectStore] Updating project: ${id}`);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`/api/projects/${id}`, {
            method: "PUT",
            headers: getHeaders(),
            body: JSON.stringify(data),
          }),
        catch: (e) => new Error(`Failed to update project: ${String(e)}`),
      });

      if (!response.ok) {
        const errObj = yield* Effect.tryPromise({
          try: () => response.json() as Promise<{ error: string }>,
          catch: () => ({ error: `HTTP ${response.status}` }),
        });
        return yield* Effect.fail(new Error(errObj.error));
      }

      const updated = yield* Effect.tryPromise({
        try: () => response.json() as Promise<Project>,
        catch: (e) => new Error(`Failed to parse updated project: ${String(e)}`),
      });

      projectsSignal.value = projectsSignal.peek().map((p) => (p.id === id ? updated : p));
      
      if (activeProjectSignal.peek()?.id === id) {
        yield* projectStore.selectProject(updated);
      }

      return updated;
    }),

  deleteProject: (id: string) =>
    Effect.gen(function* () {
      yield* clientLog("warn", `[projectStore] Deleting project: ${id}`);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`/api/projects/${id}`, {
            method: "DELETE",
            headers: getHeaders(),
          }),
        catch: (e) => new Error(`Failed to delete project: ${String(e)}`),
      });

      if (!response.ok) {
        return yield* Effect.fail(new Error(`Failed to delete project: HTTP ${response.status}`));
      }

      projectsSignal.value = projectsSignal.peek().filter((p) => p.id !== id);

      if (activeProjectSignal.peek()?.id === id) {
        yield* projectStore.selectProject(null);
      }
    }),

  selectProject: (project: Project | null) =>
    Effect.gen(function* () {
      activeProjectSignal.value = project;
      const { selectedScopeSignal } = yield* Effect.promise(() => import("./directoryStore"));
      selectedScopeSignal.value = "";

      if (project) {
        localStorage.setItem("grug-cwd", project.root_path);
        yield* clientLog("info", `[projectStore] Project selected: ${project.name} (CWD: ${project.root_path})`);
        
        const { fetchWorkspaceDirectories } = yield* Effect.promise(() => import("./directoryStore"));
        yield* fetchWorkspaceDirectories(project.root_path).pipe(Effect.catchAll(() => Effect.void));

        const { taskStore } = yield* Effect.promise(() => import("./taskStore"));
        yield* taskStore.reconcileActiveTransaction(project.root_path).pipe(Effect.catchAll(() => Effect.void));
      } else {
        localStorage.removeItem("grug-cwd");
        yield* clientLog("info", "[projectStore] Project selection cleared.");
      }
    }),

  clear: () =>
    Effect.gen(function* () {
      projectsSignal.value = [];
      activeProjectSignal.value = null;
      localStorage.removeItem("grug-cwd");
    }),
};

export const createProjectSelectMachine = (projects: readonly Project[], onSelect: (val: string) => void) => {
  const collection = select.collection({
    items: [...projects],
    itemToString: (item) => item ? `${item.name} (${item.root_path})` : "Select Project",
    itemToValue: (item) => item ? item.id : "",
  });

  return new VanillaMachine(select.machine, {
    id: "project-select",
    collection,
    onValueChange(details: select.ValueChangeDetails<string>) {
      const selectedValue = details.value[0] || "";
      onSelect(selectedValue);
    },
  });
};

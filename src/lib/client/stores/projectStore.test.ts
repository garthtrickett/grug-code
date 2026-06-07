import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runClientPromise } from "../runtime";
import {
  projectStore,
  projectsSignal,
  activeProjectSignal,
  type Project,
} from "./projectStore";

describe("projectStore - Client Preact Signals Store", () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await runClientPromise(projectStore.clear());
    localStorage.removeItem("grug-token");
    localStorage.removeItem("grug-cwd");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("should initialize default state correctly on clear", () => {
    expect(projectsSignal.value.length).toBe(0);
    expect(activeProjectSignal.value).toBeNull();
    expect(localStorage.getItem("grug-cwd")).toBeNull();
  });

    it("should successfully trigger fetchProjects and reconcile active project", async () => {
        const mockProjects: readonly Project[] = [
      {
        id: "p-1",
        name: "Test Project A",
        root_path: "/work/a",
        type_check_command: null,
        lint_command: null,
        test_command: null,
        startup_command: null,
      },
      {
        id: "p-2",
        name: "Test Project B",
        root_path: "/work/b",
        type_check_command: "tsc",
        lint_command: "eslint",
        test_command: "vitest",
        startup_command: null,
      },
    ];

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/projects")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockProjects,
        });
      }
      if (url.includes("/api/workspace/status")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => null,
        });
      }
      if (url.includes("/api/workspace/directories")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    }) as any;

    localStorage.setItem("grug-cwd", "/work/b");

    const data = await runClientPromise(projectStore.fetchProjects());
    expect(data).toEqual(mockProjects);
    expect(projectsSignal.value).toEqual(mockProjects);
    expect(activeProjectSignal.value).toEqual(mockProjects[1]);
  });

    it("should successfully trigger createProject and select the created project", async () => {
        const created: Project = {
      id: "p-new",
      name: "New Project",
      root_path: "/work/new",
      type_check_command: null,
      lint_command: null,
      test_command: null,
      startup_command: "nix develop",
    };

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/projects")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => created,
        });
      }
      if (url.includes("/api/workspace/status")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => null,
        });
      }
      if (url.includes("/api/workspace/directories")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    }) as any;

        const result = await runClientPromise(projectStore.createProject({
      name: "New Project",
      root_path: "/work/new",
      type_check_command: null,
      lint_command: null,
      test_command: null,
      startup_command: null,
    }));

    expect(result).toEqual(created);
    expect(projectsSignal.peek()).toContainEqual(created);
    expect(activeProjectSignal.peek()).toEqual(created);
    expect(localStorage.getItem("grug-cwd")).toBe("/work/new");
  });

    it("should update project details successfully", async () => {
        const initial: Project = {
      id: "p-update",
      name: "Initial Name",
      root_path: "/work/up",
      type_check_command: null,
      lint_command: null,
      test_command: null,
      startup_command: null,
    };
    projectsSignal.value = [initial];
    activeProjectSignal.value = initial;

    const updated: Project = {
      ...initial,
      name: "Updated Name",
      type_check_command: "bun x tsc",
      startup_command: "nix develop",
    };

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/projects")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => updated,
        });
      }
      if (url.includes("/api/workspace/status")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => null,
        });
      }
      if (url.includes("/api/workspace/directories")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    }) as any;

        const result = await runClientPromise(projectStore.updateProject("p-update", {
      name: "Updated Name",
      root_path: "/work/up",
      type_check_command: "bun x tsc",
      lint_command: null,
      test_command: null,
      startup_command: "nix develop",
    }));

    expect(result).toEqual(updated);
    expect(projectsSignal.peek()[0]?.name).toBe("Updated Name");
    expect(activeProjectSignal.peek()?.name).toBe("Updated Name");
  });

    it("should delete project cleanly and reset active selection", async () => {
    const project: Project = {
      id: "p-del",
      name: "Delete Me",
      root_path: "/work/del",
      type_check_command: null,
      lint_command: null,
      test_command: null,
      startup_command: null,
    };
    projectsSignal.value = [project];
    activeProjectSignal.value = project;
    localStorage.setItem("grug-cwd", "/work/del");

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }) as any;

    await runClientPromise(projectStore.deleteProject("p-del"));

    expect(projectsSignal.peek().length).toBe(0);
    expect(activeProjectSignal.peek()).toBeNull();
    expect(localStorage.getItem("grug-cwd")).toBeNull();
  });
});

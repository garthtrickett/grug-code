import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { app } from "../index";
import { getActiveToken } from "../middleware/security";
import { db } from "../../db/client";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("Elysia Companion Server - Projects Endpoint CRUD E2E", () => {
  const token = getActiveToken();

  beforeEach(async () => {
    await db.deleteFrom("project").execute();
  });

  afterEach(async () => {
    await db.deleteFrom("project").execute();
  });

  it("should reject requests without a valid security token with 401", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "GET",
      })
    );
    expect(response.status).toBe(401);
    const data = await response.json() as any;
    expect(data.error).toContain("Unauthorized");
  });

  it("should successfully perform positive CRUD operations", async () => {
    // 1. POST (Create)
    const createRes = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          name: "Project Alpha",
          root_path: "/workspace/project-alpha",
                    type_check_command: "tsc",
          lint_command: "eslint",
          test_command: "vitest",
          startup_command: "nix develop",
        }),
      })
    );

        expect(createRes.status).toBe(200);
    const createdProject = await createRes.json() as any;
    expect(createdProject.id).toBeDefined();
    expect(createdProject.name).toBe("Project Alpha");
    expect(createdProject.root_path).toBe("/workspace/project-alpha");
    expect(createdProject.startup_command).toBe("nix develop");
    expect(createdProject.uses_devcontainer).toBe(false);

    const projectId = createdProject.id;

    // 2. GET (All)
    const listRes = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "GET",
        headers: {
          "X-Grug-Token": token,
        },
      })
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as any[];
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(projectId);

    // 3. GET (Single)
    const singleRes = await app.handle(
      new Request(`http://localhost/api/projects/${projectId}`, {
        method: "GET",
        headers: {
          "X-Grug-Token": token,
        },
      })
    );
    expect(singleRes.status).toBe(200);
    const single = await singleRes.json() as any;
    expect(single.name).toBe("Project Alpha");

        // 4. PUT (Update)
    const updateRes = await app.handle(
      new Request(`http://localhost/api/projects/${projectId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          name: "Project Alpha Updated",
          root_path: "/workspace/project-alpha-updated",
          type_check_command: "tsc --noEmit",
          lint_command: "eslint .",
          test_command: "vitest run",
          startup_command: "nix develop --command",
          uses_devcontainer: true,
        }),
      })
    );
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json() as any;
    expect(updated.name).toBe("Project Alpha Updated");
    expect(updated.root_path).toBe("/workspace/project-alpha-updated");
    expect(updated.startup_command).toBe("nix develop --command");
    expect(updated.uses_devcontainer).toBe(true);

    // 5. DELETE (Delete)
    const deleteRes = await app.handle(
      new Request(`http://localhost/api/projects/${projectId}`, {
        method: "DELETE",
        headers: {
          "X-Grug-Token": token,
        },
      })
    );
    expect(deleteRes.status).toBe(200);
    const deleteResult = await deleteRes.json() as any;
    expect(deleteResult.success).toBe(true);

        // 6. Verify deleted (GET single 404)
    const singleAfterDeleteRes = await app.handle(
      new Request(`http://localhost/api/projects/${projectId}`, {
        method: "GET",
        headers: {
          "X-Grug-Token": token,
        },
      })
    );
    expect(singleAfterDeleteRes.status).toBe(404);
  });

  it("should successfully perform positive CRUD operations with some null fields", async () => {
    const createRes = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          name: "Project Nullable Fields",
          root_path: "/workspace/project-nullable-fields",
                    type_check_command: "tsc",
          lint_command: null,
          test_command: null,
          startup_command: null,
        }),
      })
    );

    expect(createRes.status).toBe(200);
    const createdProject = await createRes.json() as any;
    expect(createdProject.id).toBeDefined();
    expect(createdProject.name).toBe("Project Nullable Fields");
    expect(createdProject.lint_command).toBeNull();
    expect(createdProject.test_command).toBeNull();
    expect(createdProject.startup_command).toBeNull();
  });

  it("should fail validation if required fields are empty", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          name: "",
          root_path: "/workspace/project-invalid",
        }),
      })
    );
    expect(response.status).toBe(422);
  });

  it("should reject duplicate root_path with 409 Conflict", async () => {
    await app.handle(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          name: "Project One",
          root_path: "/workspace/same-path",
        }),
      })
    );

    const response = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grug-Token": token,
        },
        body: JSON.stringify({
          name: "Project Two",
          root_path: "/workspace/same-path",
        }),
      })
    );

        expect(response.status).toBe(409);
    const data = await response.json() as any;
    expect(data.error).toContain("already exists");
  });

  it("should automatically detect uses_devcontainer if not explicitly provided", async () => {
    const tempWorkDir = path.join(process.cwd(), `.grug-routes-detect-${crypto.randomUUID()}`);
    await fs.mkdir(path.join(tempWorkDir, ".devcontainer"), { recursive: true });
    await fs.writeFile(path.join(tempWorkDir, ".devcontainer/devcontainer.json"), "{}");

    try {
      const createRes = await app.handle(
        new Request("http://localhost/api/projects", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Grug-Token": token,
          },
          body: JSON.stringify({
            name: "Auto Detect Project",
            root_path: tempWorkDir,
          }),
        })
      );

      expect(createRes.status).toBe(200);
      const createdProject = await createRes.json() as any;
      expect(createdProject.uses_devcontainer).toBe(true);
    } finally {
      await fs.rm(tempWorkDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
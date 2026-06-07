import { describe, it, expect } from "vitest";
import { db } from "./client";
import type { ProjectId } from "../types";

describe("Project Database Schema and Migration", () => {
  it("should successfully insert, query, update, and delete project rows", async () => {
    const projectId = crypto.randomUUID() as ProjectId;

    // 1. Insert
    const insertResult = await db
      .insertInto("project")
      .values({
        id: projectId,
        name: "Grug Code Test Project",
        root_path: "/workspace/grug-code-test-project",
        type_check_command: "tsc --noEmit",
        lint_command: "eslint .",
        test_command: "vitest run",
      })
      .executeTakeFirst();

    expect(insertResult).toBeDefined();

    // 2. Query
    const project = await db
      .selectFrom("project")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();

    expect(project).toBeDefined();
    expect(project?.name).toBe("Grug Code Test Project");
    expect(project?.root_path).toBe("/workspace/grug-code-test-project");
    expect(project?.type_check_command).toBe("tsc --noEmit");
    expect(project?.lint_command).toBe("eslint .");
    expect(project?.test_command).toBe("vitest run");
    expect(project?.created_at).toBeInstanceOf(Date);
    expect(project?.updated_at).toBeInstanceOf(Date);

    // 3. Update
    await db
      .updateTable("project")
      .set({
        name: "Grug Code Updated Project",
        test_command: "vitest run --coverage",
        updated_at: new Date(),
      })
      .where("id", "=", projectId)
      .execute();

    const updatedProject = await db
      .selectFrom("project")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();

    expect(updatedProject?.name).toBe("Grug Code Updated Project");
    expect(updatedProject?.test_command).toBe("vitest run --coverage");

    // 4. Delete
    await db
      .deleteFrom("project")
      .where("id", "=", projectId)
      .execute();

    const deletedProject = await db
      .selectFrom("project")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();

    expect(deletedProject).toBeUndefined();
  });
});
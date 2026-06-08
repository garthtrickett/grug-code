import { describe, it, expect } from "vitest";
import { db } from "./client";
import type { ProjectId } from "../types";
import { Migrator } from "kysely";
import { migrationObjects } from "./migrations/migrations-manifest";

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
        startup_command: "nix develop",
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
    expect(project?.startup_command).toBe("nix develop");
    expect(project?.uses_devcontainer).toBe(false);
    expect(project?.created_at).toBeInstanceOf(Date);
    expect(project?.updated_at).toBeInstanceOf(Date);

    // 3. Update
    await db
      .updateTable("project")
      .set({
        name: "Grug Code Updated Project",
        test_command: "vitest run --coverage",
        startup_command: "nix develop --command",
        uses_devcontainer: true,
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
    expect(updatedProject?.uses_devcontainer).toBe(true);

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

  it("should apply and roll back the uses_devcontainer migration without breaking database integrity", async () => {
    const migrator = new Migrator({
      db,
      provider: {
        getMigrations: () => Promise.resolve(migrationObjects),
      },
    });

    const downResult = await migrator.migrateDown();
    expect(downResult.error).toBeUndefined();

    const tableMetadataAfterDown = await db.introspection.getTables();
    const projectTableAfterDown = tableMetadataAfterDown.find(t => t.name === "project");
    const columnExistsAfterDown = projectTableAfterDown?.columns.some(c => c.name === "uses_devcontainer");
    expect(columnExistsAfterDown).toBe(false);

    const upResult = await migrator.migrateToLatest();
    expect(upResult.error).toBeUndefined();

    const tableMetadataAfterUp = await db.introspection.getTables();
    const projectTableAfterUp = tableMetadataAfterUp.find(t => t.name === "project");
    const columnExistsAfterUp = projectTableAfterUp?.columns.some(c => c.name === "uses_devcontainer");
    expect(columnExistsAfterUp).toBe(true);
  });
});
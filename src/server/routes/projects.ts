import { Elysia, t } from "elysia";
import { Effect } from "effect";
import { db } from "../../db/client.ts";
import { securityMiddleware } from "../middleware/security.ts";
import { effectPlugin } from "../middleware/effect-plugin.ts";
import type { ProjectId } from "../../types/index.ts";

export const projectRoutes = new Elysia({ prefix: "/api/projects" })
  .use(effectPlugin)
  .use(securityMiddleware)
  .get("/", async ({ runEffect, set }) => {
    const effect = Effect.tryPromise({
      try: () => db.selectFrom("project").selectAll().orderBy("name", "asc").execute(),
      catch: (e) => new Error(`Database error: ${String(e)}`),
    });

    const result = await runEffect(Effect.either(effect));
    if (result._tag === "Left") {
      set.status = 500;
      return { error: result.left.message };
    }
    return result.right;
  })
  .get("/:id", async ({ params, runEffect, set }) => {
    const id = params.id as ProjectId;
    const effect = Effect.tryPromise({
      try: () => db.selectFrom("project").selectAll().where("id", "=", id).executeTakeFirst(),
      catch: (e) => new Error(`Database error: ${String(e)}`),
    });

    const result = await runEffect(Effect.either(effect));
    if (result._tag === "Left") {
      set.status = 500;
      return { error: result.left.message };
    }
    if (!result.right) {
      set.status = 404;
      return { error: "Project not found" };
    }
    return result.right;
  })
  .post("/", async ({ body, runEffect, set }) => {
    const id = crypto.randomUUID() as ProjectId;
    const effect = Effect.tryPromise({
      try: () => db.insertInto("project")
        .values({
          id,
          name: body.name,
          root_path: body.root_path,
          type_check_command: body.type_check_command ?? null,
          lint_command: body.lint_command ?? null,
          test_command: body.test_command ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
      catch: (e) => {
        const msg = String(e);
        if (msg.includes("unique constraint") || msg.includes("duplicate key")) {
          return new Error("Project with this root_path already exists");
        }
        return new Error(`Database error: ${msg}`);
      },
    });

    const result = await runEffect(Effect.either(effect));
    if (result._tag === "Left") {
      if (result.left.message === "Project with this root_path already exists") {
        set.status = 409;
      } else {
        set.status = 500;
      }
      return { error: result.left.message };
    }
    return result.right;
  }, {
    body: t.Object({
      name: t.String({ minLength: 1 }),
      root_path: t.String({ minLength: 1 }),
      type_check_command: t.Optional(t.String()),
      lint_command: t.Optional(t.String()),
      test_command: t.Optional(t.String()),
    })
  })
  .put("/:id", async ({ params, body, runEffect, set }) => {
    const id = params.id as ProjectId;
    const effect = Effect.tryPromise({
      try: () => db.updateTable("project")
        .set({
          name: body.name,
          root_path: body.root_path,
          type_check_command: body.type_check_command ?? null,
          lint_command: body.lint_command ?? null,
          test_command: body.test_command ?? null,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst(),
      catch: (e) => {
        const msg = String(e);
        if (msg.includes("unique constraint") || msg.includes("duplicate key")) {
          return new Error("Project with this root_path already exists");
        }
        return new Error(`Database error: ${msg}`);
      },
    });

    const result = await runEffect(Effect.either(effect));
    if (result._tag === "Left") {
      if (result.left.message === "Project with this root_path already exists") {
        set.status = 409;
      } else {
        set.status = 500;
      }
      return { error: result.left.message };
    }
    if (!result.right) {
      set.status = 404;
      return { error: "Project not found" };
    }
    return result.right;
  }, {
    body: t.Object({
      name: t.String({ minLength: 1 }),
      root_path: t.String({ minLength: 1 }),
      type_check_command: t.Optional(t.String()),
      lint_command: t.Optional(t.String()),
      test_command: t.Optional(t.String()),
    })
  })
  .delete("/:id", async ({ params, runEffect, set }) => {
    const id = params.id as ProjectId;
    const effect = Effect.tryPromise({
      try: () => db.deleteFrom("project").where("id", "=", id).returningAll().executeTakeFirst(),
      catch: (e) => new Error(`Database error: ${String(e)}`),
    });

    const result = await runEffect(Effect.either(effect));
    if (result._tag === "Left") {
      set.status = 500;
      return { error: result.left.message };
    }
    if (!result.right) {
      set.status = 404;
      return { error: "Project not found" };
    }
    return { success: true };
  });
import { Elysia, t } from "elysia";
import { Effect } from "effect";
import { makeWorkspaceController } from "../../lib/server/WorkspaceController";
import { makeCommandRunner } from "../../lib/server/CommandRunner";
import { securityMiddleware } from "../middleware/security";
import { effectPlugin } from "../middleware/effect-plugin";

const runner = makeCommandRunner();

export const workspaceRoutes = new Elysia({ prefix: "/api/workspace" })
  .use(effectPlugin)
  .use(securityMiddleware)
  .post("/init", async ({ body, runEffect, set }) => {
    const controller = makeWorkspaceController(body.cwd);
    const effect = controller.initTransaction(body.taskId);
    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: res.left.message };
    }
    return res.right;
  }, {
    body: t.Object({
      taskId: t.String(),
      cwd: t.Optional(t.String())
    })
  })
  .post("/verify", async ({ body, runEffect, set }) => {
    const type = body.type;
    const effect = type === "typecheck" 
      ? runner.runTypeCheck(body.cwd, 30000) 
      : runner.runTestSuite(body.cwd, 45000);
    
    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: res.left.message };
    }
    return res.right;
  }, {
    body: t.Object({
      tx: t.Object({
        id: t.String(),
        baseBranch: t.String(),
        ephemeralBranch: t.String(),
        checkpoints: t.Array(t.String())
      }),
      type: t.Union([t.Literal("typecheck"), t.Literal("test")]),
      cwd: t.Optional(t.String())
    })
  })
  .post("/rollback", async ({ body, runEffect, set }) => {
    const tx = body.tx;
    const controller = makeWorkspaceController(body.cwd);
    const effect = controller.rollbackToCheckpoint(tx, body.commitHash);
    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: res.left.message };
    }
    return res.right;
  }, {
    body: t.Object({
      tx: t.Object({
        id: t.String(),
        baseBranch: t.String(),
        ephemeralBranch: t.String(),
        checkpoints: t.Array(t.String())
      }),
      commitHash: t.String(),
      cwd: t.Optional(t.String())
    })
  })
  .post("/abort", async ({ body, runEffect, set }) => {
    const controller = makeWorkspaceController(body.cwd);
    const effect = controller.abortTransaction(body.tx);
    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: res.left.message };
    }
    return { success: true };
  }, {
    body: t.Object({
      tx: t.Object({
        id: t.String(),
        baseBranch: t.String(),
        ephemeralBranch: t.String(),
        checkpoints: t.Array(t.String())
      }),
      cwd: t.Optional(t.String())
    })
  })
  .post("/commit", async ({ body, runEffect, set }) => {
    const controller = makeWorkspaceController(body.cwd);
    const effect = controller.commitTransaction(body.tx);
    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: res.left.message };
    }
    return { success: true };
  }, {
    body: t.Object({
      tx: t.Object({
        id: t.String(),
        baseBranch: t.String(),
        ephemeralBranch: t.String(),
        checkpoints: t.Array(t.String())
      }),
      cwd: t.Optional(t.String())
    })
  });

import { Elysia, t } from "elysia";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeWorkspaceController } from "../../lib/server/WorkspaceController";
import { makeCommandRunner } from "../../lib/server/CommandRunner";
import { TreeSitterParser, TreeSitterParserLive } from "../../lib/server/TreeSitterParser";
import { extractSkeleton } from "../../lib/server/SkeletalExplorer";
import { securityMiddleware } from "../middleware/security";
import { SurgicalRouter, SurgicalRouterLive } from "../../lib/server/SurgicalRouter";
import { TokenEstimatorLive } from "../../lib/server/TokenEstimator";
import { effectPlugin } from "../middleware/effect-plugin";
import { PatchApplicationError } from "../../lib/server/AiderPatcher";

const runner = makeCommandRunner();

export const workspaceRoutes = new Elysia({ prefix: "/api/workspace" })
  .use(effectPlugin)
  .use(securityMiddleware)
    .post("/route-execution", async ({ body, runEffect, set }) => {
    const rootDir = body.cwd || process.cwd();
    const resolvedPaths = body.paths.map((p) => {
      return path.isAbsolute(p) ? p : path.resolve(rootDir, p);
    });

    const effect = SurgicalRouter.pipe(
      Effect.flatMap((router) => router.routeExecution(resolvedPaths)),
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: res.left.message };
    }
    return res.right;
  }, {
    body: t.Object({
      paths: t.Array(t.String()),
      cwd: t.Optional(t.String())
    })
  })
  .post("/assemble-anchors", async ({ body, runEffect, set }) => {
    const effect = Effect.gen(function* () {
      const getSafeFilePath = (rawPath: string, cwd?: string) =>
        Effect.gen(function* () {
          const rootDir = path.resolve(cwd || process.cwd());
          const resolved = path.resolve(rootDir, rawPath);
          if (!resolved.startsWith(rootDir)) {
            return yield* Effect.fail(new Error(`Path traversal attempt detected: ${rawPath}`));
          }
          return resolved;
        });

      const processFile = (filePath: string) =>
        Effect.gen(function* () {
          const { parser } = yield* TreeSitterParser;
          const safePath = yield* getSafeFilePath(filePath, body.cwd);

          const exists = yield* Effect.tryPromise({
            try: () => fs.promises.stat(safePath).then(() => true).catch(() => false),
            catch: (e) => new Error(`Stat failed: ${String(e)}`),
          });

          if (!exists) {
            return { filePath, content: "", error: "File not found" };
          }

          const fileContent = yield* Effect.tryPromise({
            try: () => fs.promises.readFile(safePath, "utf-8"),
            catch: (e) => new Error(`Failed to read file ${filePath}: ${String(e)}`),
          });

          const skeleton = yield* extractSkeleton(fileContent, parser, body.anchors);
          return { filePath, content: skeleton };
        });

      return yield* Effect.all(
        body.paths.map((p) => processFile(p)),
        { concurrency: "unbounded" }
      );
    }).pipe(Effect.provide(TreeSitterParserLive));

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
      paths: t.Array(t.String()),
      anchors: t.Array(t.Object({
        entityType: t.Union([t.Literal("class"), t.Literal("function"), t.Literal("method")]),
        entityName: t.String()
      })),
      cwd: t.Optional(t.String())
    })
  })
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
  .post("/patch", async ({ body, runEffect, set }) => {
    const controller = makeWorkspaceController(body.cwd);
    const patchPayload = typeof body.patch === "string" ? body.patch : JSON.stringify(body.patch);
    const effect = controller.applyPatch(body.tx, patchPayload).pipe(
      Effect.provide(TreeSitterParserLive)
    );
    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      const error = res.left;
            if (error instanceof PatchApplicationError) {
        return {
          error: error.message,
          filePath: error.path && body.cwd ? path.relative(body.cwd, error.path) : error.path,
          failedSearchBlock: error.failedSearchBlock,
          proposedReplacement: error.proposedReplacement,
          actualContextSnippet: error.actualContextSnippet,
        };
      }
      return { error: (error).message };
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
      patch: t.Union([
        t.String(),
        t.Object({
          summary: t.Optional(t.String()),
          files: t.Array(t.Object({
            file_path: t.String(),
            code_diff: t.String()
          }))
        })
      ]),
      cwd: t.Optional(t.String())
    })
  })
  .post("/skeletons", async ({ body, runEffect, set }) => {
    const effect = Effect.gen(function* () {
      const getSafeFilePath = (rawPath: string, cwd?: string) =>
        Effect.gen(function* () {
          const rootDir = path.resolve(cwd || process.cwd());
          const resolved = path.resolve(rootDir, rawPath);
          if (!resolved.startsWith(rootDir)) {
            return yield* Effect.fail(new Error(`Path traversal attempt detected: ${rawPath}`));
          }
          return resolved;
        });

      const processFile = (filePath: string) =>
        Effect.gen(function* () {
          const { parser } = yield* TreeSitterParser;
          const safePath = yield* getSafeFilePath(filePath, body.cwd);

          const exists = yield* Effect.tryPromise({
            try: () => fs.promises.stat(safePath).then(() => true).catch(() => false),
            catch: (e) => new Error(`Stat failed: ${String(e)}`),
          });

          if (!exists) {
            return { filePath, content: "", error: "File not found" };
          }

          const fileContent = yield* Effect.tryPromise({
            try: () => fs.promises.readFile(safePath, "utf-8"),
            catch: (e) => new Error(`Failed to read file ${filePath}: ${String(e)}`),
          });

          const skeleton = yield* extractSkeleton(fileContent, parser);
          return { filePath, content: skeleton };
        });

      return yield* Effect.all(
        body.paths.map((p) => processFile(p)),
        { concurrency: "unbounded" }
      );
    }).pipe(Effect.provide(TreeSitterParserLive));

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
      paths: t.Array(t.String()),
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

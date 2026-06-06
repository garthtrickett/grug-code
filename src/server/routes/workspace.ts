import { Elysia, t } from "elysia";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeWorkspaceController } from "../../lib/server/WorkspaceController.ts";
import { makeCommandRunner } from "../../lib/server/CommandRunner.ts";
import { TreeSitterParser, TreeSitterParserLive } from "../../lib/server/TreeSitterParser.ts";
import { extractSkeleton } from "../../lib/server/SkeletalExplorer.ts";
import { securityMiddleware } from "../middleware/security.ts";
import { SurgicalRouter, SurgicalRouterLive } from "../../lib/server/SurgicalRouter.ts";
import { TokenEstimatorLive } from "../../lib/server/TokenEstimator.ts";
import { effectPlugin } from "../middleware/effect-plugin.ts";
import { PatchApplicationError } from "../../lib/server/AiderPatcher.ts";

// Step 3 Integration Services
import { ResearchLoop, ResearchLoopLive } from "../../features/agent/ResearchLoop.ts";
import { ProjectStructureMapper, ProjectStructureMapperLive } from "../../features/agent/ProjectStructureMapper.ts";
import { AiServiceLive } from "../../lib/server/AiService.ts";
import { CorrectionLoop, CorrectionLoopLive } from "../../features/agent/CorrectionLoop.ts";

const runner = makeCommandRunner();

const txSchema = t.Object({
  id: t.String(),
  baseBranch: t.String(),
  ephemeralBranch: t.String(),
  checkpoints: t.Array(t.String()),
  provider: t.Optional(t.Union([t.Literal("gemini"), t.Literal("openai"), t.Literal("deepseek")]))
});

export const workspaceRoutes = new Elysia({ prefix: "/api/workspace" })
  .use(effectPlugin)
  .use(securityMiddleware)
  .get("/progress", () => {
    return { progress: "Grug working hard..." };
  })
  .post("/directories", async ({ body, runEffect, set }) => {
    const controller = makeWorkspaceController(body.cwd);
    const effect = controller.listDirectories();
    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: (res.left).message };
    }
    return res.right;
  }, {
    body: t.Object({
      cwd: t.Optional(t.String())
    })
  })
  .post("/route-execution", async ({ body, runEffect, set }) => {
    const rootDir = body.cwd || process.cwd();
    const resolvedPaths = body.paths.map((p) => {
      return path.isAbsolute(p) ? p : path.resolve(rootDir, p);
    });

    const effect = Effect.flatMap(SurgicalRouter, (router) =>
      router.routeExecution(resolvedPaths)
    ).pipe(
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: (res.left).message };
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
      return { error: (res.left).message };
    }
    return res.right;
  }, { 
    body: t.Object({
      tx: txSchema,
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
    const effect = controller.initTransaction(body.taskId, body.provider);
    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: (res.left).message };
    }
    return res.right;
  }, {
    body: t.Object({
      taskId: t.String(),
      cwd: t.Optional(t.String()),
      provider: t.Optional(t.Union([t.Literal("gemini"), t.Literal("openai"), t.Literal("deepseek")]))
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
      return { error: error.message };
    }
    return { success: true };
  }, { 
    body: t.Object({
      tx: txSchema,
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
      return { error: (res.left).message };
    }
    return res.right;
  }, { 
    body: t.Object({
      tx: txSchema,
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
      return { error: (res.left).message };
    }
    return res.right;
  }, { 
    body: t.Object({
      tx: txSchema,
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
      return { error: (res.left).message };
    }
    return res.right;
  }, { 
    body: t.Object({
      tx: txSchema,
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
      return { error: (res.left).message };
    }
    return { success: true };
  }, { 
    body: t.Object({
      tx: txSchema,
      cwd: t.Optional(t.String())
    })
  })
  .post("/commit", async ({ body, runEffect, set }) => {
    const controller = makeWorkspaceController(body.cwd);
    const effect = controller.commitTransaction(body.tx);
    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") { 
      set.status = 400;
      return { error: (res.left).message };
    }
    return { success: true };
  }, { 
    body: t.Object({
      tx: txSchema,
      cwd: t.Optional(t.String())
    })
  })
  .post("/execute-step", async ({ body, runEffect, set }) => {
    const effect = Effect.flatMap(CorrectionLoop, (loop) =>
      loop.runStep({
        tx: body.tx,
        targetFiles: body.targetFiles,
        instructions: body.instructions,
        cwd: body.cwd,
      })
    ).pipe(
      Effect.provide(CorrectionLoopLive),
      Effect.provide(AiServiceLive),
      Effect.provide(TreeSitterParserLive)
    );

    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: res.left.message };
    }
    return res.right;
  }, {
    body: t.Object({
      tx: txSchema,
      targetFiles: t.Array(t.String()),
      instructions: t.String(),
      cwd: t.Optional(t.String())
    })
  })
  .post("/research", async ({ body, runEffect, set }) => {
    const effect = Effect.gen(function* () {
      yield* Effect.logInfo("[WorkspaceRoute] Received POST /research request");
      const mapper = yield* ProjectStructureMapper;
      const loop = yield* ResearchLoop;

      // 1. Scan and index relative codebase path layout
      const projectStructure = yield* mapper.mapProject({ cwd: body.cwd });
      yield* Effect.logInfo("[WorkspaceRoute] ProjectStructureMapper.mapProject completed successfully.");

      // 2. Dispatch prompts and execute multi-turn exploration sequence
      const result = yield* loop.run({
        userPrompt: body.userPrompt,
        projectStructure,
        cwd: body.cwd,
        provider: body.provider,
        mode: body.mode,
        history: body.history,
      });
      yield* Effect.logInfo("[WorkspaceRoute] ResearchLoop.run process completed successfully.");

      return result;
    }).pipe(
      Effect.provide(ResearchLoopLive),
      Effect.provide(ProjectStructureMapperLive),
      Effect.provide(AiServiceLive),
      Effect.provide(TreeSitterParserLive),
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    const res = await runEffect(Effect.either(effect));
    if (res._tag === "Left") {
      set.status = 400;
      return { error: (res.left).message };
    }
    await runEffect(Effect.logInfo("[WorkspaceRoute] Returning res.right back to Elysia client"));
    return JSON.parse(JSON.stringify(res.right)) as unknown;
  }, {
    body: t.Object({
      userPrompt: t.String(),
      cwd: t.Optional(t.String()),
      provider: t.Optional(t.Union([t.Literal("gemini"), t.Literal("openai"), t.Literal("deepseek")])),
      mode: t.Optional(t.Union([t.Literal("standard"), t.Literal("discussion")])),
      history: t.Optional(t.Array(t.Object({
        role: t.Union([t.Literal("user"), t.Literal("assistant")]),
        text: t.String()
      })))
    })
  });

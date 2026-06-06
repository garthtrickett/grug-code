import { Context, Effect, Layer } from "effect";
import { AiService, AIInferenceError } from "../../lib/server/AiService";
import { TreeSitterParser } from "../../lib/server/TreeSitterParser";
import { extractSkeleton, ParserError } from "../../lib/server/SkeletalExplorer";
import { PlanningResponseSchema, PlanTask } from "../../lib/shared/ai-schemas";
import { Data } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export class LoopThresholdExceeded extends Data.TaggedError("LoopThresholdExceeded")<{
  readonly message: string;
}> {}

export class ResearchLoopError extends Data.TaggedError("ResearchLoopError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface IResearchLoop {
  readonly run: (options: {
    readonly userPrompt: string;
    readonly projectStructure: string;
    readonly cwd?: string;
    readonly provider?: "gemini" | "openai";
  }) => Effect.Effect<
    {
      readonly target_files: readonly string[];
      readonly plan: readonly PlanTask[];
    },
    LoopThresholdExceeded | ResearchLoopError | AIInferenceError | ParserError,
    AiService | TreeSitterParser
  >;
}

export class ResearchLoop extends Context.Tag("ResearchLoop")<
  ResearchLoop,
  IResearchLoop
>() {}

export const ResearchLoopLive = Layer.succeed(
  ResearchLoop,
  ResearchLoop.of({
    run: ({ userPrompt, projectStructure, cwd, provider }) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("[ResearchLoop] Starting Stage 1 Skeletal Research Loop...");

        const ai = yield* AiService;
        const parserService = yield* TreeSitterParser;

        const skeletonsMap = new Map<string, string>();
        let turnCount = 0;
        let resolvedPlan: { target_files: readonly string[]; plan: readonly PlanTask[] } | null = null;

        const systemPrompt = `You are Grug Code Planning LLM, acting as a dependency-aware pre-planning research router.
Your objective is to review the lightweight flat map representation of the project structure and request the structural skeletons of the candidate files you think are highly relevant to planning the requested changes.

Strict rules of state transition:
1. If you need more structural context (interfaces, functions, types) for candidate files to formulate an accurate edit, transition to status \"exploring\" and specify the relative file paths in \"request_skeletons_for\".
2. If you have all necessary structural information and understand how target files interact with their dependencies, transition to status \"resolved\". Formulate a concrete, step-by-step checklist of tasks in \"plan\" and identify the precise list of \"target_files\" destined for modification.
3. You must keep the number of skeletal exploration turns minimal to maintain low-latency interactions. Avoid requesting files that are unrelated to the current target task.
`;

        const getSafePath = (rawPath: string) =>
          Effect.gen(function* () {
            const rootDir = path.resolve(cwd || process.cwd());
            const resolved = path.resolve(rootDir, rawPath);
            if (!resolved.startsWith(rootDir)) {
              return yield* Effect.fail(
                new ResearchLoopError({
                  message: `Security validation failed: path traversal attempt detected for file path: \"${rawPath}\"`,
                })
              );
            }
            return resolved;
          });

        while (!resolvedPlan) {
          turnCount++;
          yield* Effect.logInfo(`[ResearchLoop] Initiating turn #${turnCount} of skeletal exploration loop...`);

          // Construct conversational context based on current exploration state
          let skeletonsContext = "";
          if (skeletonsMap.size > 0) {
            skeletonsContext = "\n--- STRUCTURAL CONTEXT ACQUIRED SO FAR ---\n";
            for (const [filePath, content] of skeletonsMap.entries()) {
              skeletonsContext += `\nFile: ${filePath}\nSkeleton content:\n${content}\n`;
            }
            skeletonsContext += "\n-----------------------------------------\n";
          }

          const prompt = `USER TASK / FEATURE REQUEST:
\"${userPrompt}\"

LIGHTWEIGHT FLAT REPOSITORY MAP:
${projectStructure}
${skeletonsContext}
Please review your current state. If you need more skeletons to confirm assumptions about dependencies, imports, or type signatures, transition your status to \"exploring\" and list them. Otherwise, formulate the final plan and transition to \"resolved\".`;

          yield* Effect.logDebug(`[ResearchLoop] Dispatching turn context to AiService...`);
          const response = yield* ai.generateStructuredObject({
            system: systemPrompt,
            prompt,
            schema: PlanningResponseSchema,
            provider,
          });

          if (response.status === "resolved") {
            yield* Effect.logInfo(`[ResearchLoop] LLM successfully resolved planning on turn #${turnCount}.`);
            resolvedPlan = {
              target_files: response.target_files,
              plan: response.plan,
            };
          } else if (response.status === "exploring") {
            if (turnCount >= 4) {
              yield* Effect.logError("[ResearchLoop] Iteration cap reached. Aborting multi-turn exploration.");
              return yield* Effect.fail(
                new LoopThresholdExceeded({
                  message: `Stage 1 Skeletal Research Loop exceeded the safety threshold of 4 turns without transitioning to 'resolved'. Aborting transaction to prevent context bloat.`,
                })
              );
            }

            const requestedPaths = response.request_skeletons_for;
            yield* Effect.logInfo(
              `[ResearchLoop] LLM requested structural skeletons for files: ${JSON.stringify(requestedPaths)}`
            );

            for (const rawPath of requestedPaths) {
              if (skeletonsMap.has(rawPath)) {
                yield* Effect.logDebug(`[ResearchLoop] Bypassing already-hydrated skeleton: \"${rawPath}\"`);
                continue;
              }

              const safePath = yield* getSafePath(rawPath);
              
              const fileExists = yield* Effect.tryPromise({
                try: () => fs.stat(safePath).then(() => true).catch(() => false),
                catch: (cause) =>
                  new ResearchLoopError({
                    message: `Failed to verify existence of candidate file path: \"${rawPath}\"`,
                    cause,
                  }),
              });

              if (!fileExists) {
                yield* Effect.logWarning(`[ResearchLoop] Candidate file does not exist on disk: \"${rawPath}\". Recording stub.`);
                skeletonsMap.set(rawPath, "// File not found in workspace");
                continue;
              }

              const content = yield* Effect.tryPromise({
                try: () => fs.readFile(safePath, "utf-8"),
                catch: (cause) =>
                  new ResearchLoopError({
                    message: `Failed to read candidate file: \"${rawPath}\"`,
                    cause,
                  }),
              });

              yield* Effect.logDebug(`[ResearchLoop] Parsing syntax structures for skeleton extraction: \"${rawPath}\"`);
              const skeleton = yield* extractSkeleton(content, parserService.parser);
              skeletonsMap.set(rawPath, skeleton);
            }
          }
        }

        return resolvedPlan;
      }),
  })
);

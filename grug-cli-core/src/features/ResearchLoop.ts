import { Context, Effect, Layer } from "effect";
import { AiService, AIInferenceError } from "../lib/AiService.ts";
import { TreeSitterParser } from "../lib/TreeSitterParser.ts";
import { extractSkeleton, ParserError } from "../lib/SkeletalExplorer.ts";
import { PlanningResponseSchema, PlanTask } from "../lib/ai-schemas.ts";
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
    readonly provider?: "gemini" | "openai" | "deepseek";
    readonly mode?: "standard" | "discussion";
    readonly history?: readonly {
      readonly role: "user" | "assistant";
      readonly text: string;
    }[];
  }) => Effect.Effect<
    {
      readonly status: "discussion" | "resolved";
      readonly discussionText?: string;
      readonly suggestedOptions?: readonly string[];
      readonly target_files?: readonly string[];
      readonly plan?: readonly PlanTask[];
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
    run: ({ userPrompt, projectStructure, cwd, provider, mode = "standard", history = [] }) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`[ResearchLoop] Starting Stage 1 Skeletal Research Loop in mode: ${mode}`);

        const ai = yield* AiService;
        const parserService = yield* TreeSitterParser;

        const skeletonsMap = new Map<string, string>();
        let turnCount = 0;
        let resolvedPlan: {
          readonly status: "discussion" | "resolved";
          readonly discussionText?: string;
          readonly suggestedOptions?: readonly string[];
          readonly target_files?: readonly string[];
          readonly plan?: readonly PlanTask[];
        } | null = null;

        const systemPrompt = `You are Grug Code Planning LLM, acting as a dependency-aware pre-planning research router.
Your primary objective is to finalize the plan and transition to status "resolved" as quickly as possible (ideally on the VERY FIRST TURN).

Strict rules of state transition:
1. ONLY transition to status "exploring" if you are completely unable to formulate a plan without seeing the signatures of critical target files. Never explore more than once.
2. If you can make reasonable assumptions about the file structures, transition directly to status "resolved". Formulate a concrete, step-by-step checklist of tasks in "plan" and identify the precise list of "target_files" destined for modification.
3. Keep the number of skeletal exploration turns minimal (0 to 3 turns maximum) to maintain low-latency interactions.
`;

        const discussionSystemPrompt = `You are Grug Code Planning LLM, acting as an interactive pre-planning technical advisor.
Since "discussion" mode is enabled, your primary objective is to analyze the user's request, provide a comprehensive discussion of potential solutions, technical trade-offs, and architecture BEFORE formulating a concrete plan.

Do NOT output status "resolved" on your first turn. Instead:
1. Transition to status "discussion".
2. Write a detailed, friendly, and structured technical analysis in "discussionText" explaining the available options, code locations, and trade-offs.
3. Suggest 2-3 logical buttons/reply prompts for the user in "suggestedOptions" (e.g., ["Compare with option B", "Ask Grug for more detail about...", "Proceed with implementing this plan"]).
4. Once the user selects a confirmation path or tells you to proceed, you can transition to status "resolved" and output the "target_files" and "plan" checklist.
`;

        const getSafePath = (rawPath: string) =>
          Effect.gen(function* () { 
            const rootDir = path.resolve(cwd || process.cwd());
            const resolved = path.resolve(rootDir, rawPath);
            if (!resolved.startsWith(rootDir)) {
              return yield* Effect.fail(
                new ResearchLoopError({
                  message: `Security validation failed: path traversal attempt detected for file path: "${rawPath}"`,
                })
              );
            }
            return resolved;
          });

        while (!resolvedPlan) {
          turnCount++;
          yield* Effect.logInfo(`[ResearchLoop] Initiating turn #${turnCount} of skeletal exploration loop...`);

          let skeletonsContext = "";
          if (skeletonsMap.size > 0) {
            skeletonsContext = "\n--- STRUCTURAL CONTEXT ACQUIRED SO FAR ---\n";
            for (const [filePath, content] of skeletonsMap.entries()) {
              skeletonsContext += `\nFile: ${filePath}\nSkeleton content:\n${content}\n`;
            }
            skeletonsContext += "\n-----------------------------------------\n";
          }

          let historyContext = "";
          if (history && history.length > 0) {
            historyContext = "\n--- RECENT DISCUSSION HISTORY ---\n";
            for (const turn of history) {
              historyContext += `\n${turn.role.toUpperCase()}: ${turn.text}\n`;
            }
            historyContext += "\n---------------------------------\n";
          }

          let turnWarning = "";
          if (turnCount >= 3) {
            turnWarning = `\n⚠️ CRITICAL WARNING: You are on turn #${turnCount} of skeletal exploration. You are approaching the maximum iteration limit! You MUST transition to "resolved" or "discussion" now.`;
          }

          const prompt = `USER TASK / FEATURE REQUEST:
"${userPrompt}"
${historyContext}
LIGHTWEIGHT FLAT REPOSITORY MAP:
${projectStructure}
${skeletonsContext}${turnWarning}

Please review your current state. If you are in discussion mode, provide a response with status "discussion" containing your detailed analysis in "discussionText" and options in "suggestedOptions". If you are ready to implement, transition to status "resolved" and provide "target_files" and "plan".`;

          yield* Effect.logDebug(`[ResearchLoop] Dispatching turn context to AiService...`);
          const response = yield* ai.generateStructuredObject({
            system: mode === "discussion" ? discussionSystemPrompt : systemPrompt,
            prompt,
            schema: PlanningResponseSchema,
            provider,
          });

          if (response.status === "resolved") {
            yield* Effect.logInfo(`[ResearchLoop] LLM successfully resolved planning on turn #${turnCount}.`);
            resolvedPlan = {
              status: "resolved",
              target_files: response.target_files,
              plan: response.plan,
            };
          } else if (response.status === "discussion") {
            yield* Effect.logInfo(`[ResearchLoop] LLM returned discussion option on turn #${turnCount}.`);
            resolvedPlan = {
              status: "discussion",
              discussionText: response.discussionText,
              suggestedOptions: response.suggestedOptions,
            };
          } else if (response.status === "exploring") {
            if (turnCount >= 4) {
              return yield* Effect.fail(
                new LoopThresholdExceeded({
                  message: `Stage 1 Skeletal Research Loop exceeded the safety threshold of 4 turns without transitioning to 'resolved'. Aborting transaction to prevent context bloat.`,
                })
              );
            } 

            const requestedPaths = response.request_skeletons_for;
            for (const rawPath of requestedPaths) {
              if (skeletonsMap.has(rawPath)) {
                continue;
              }

              const safePath = yield* getSafePath(rawPath);
              
              const fileExists = yield* Effect.tryPromise({
                try: () => fs.stat(safePath).then(() => true).catch(() => false),
                catch: (cause) =>
                  new ResearchLoopError({
                    message: `Failed to verify existence of candidate file path: "${rawPath}"`,
                    cause,
                  }),
              });

              if (!fileExists) {
                skeletonsMap.set(rawPath, "// File not found in workspace");
                continue;
              }

              const content = yield* Effect.tryPromise({
                try: () => fs.readFile(safePath, "utf-8"),
                catch: (cause) =>
                  new ResearchLoopError({
                    message: `Failed to read candidate file: "${rawPath}"`,
                    cause,
                  }),
              });

              const skeleton = yield* extractSkeleton(content, parserService.parser);
              skeletonsMap.set(rawPath, skeleton);
            }
          }
        }

        return resolvedPlan;
      }),
  })
);
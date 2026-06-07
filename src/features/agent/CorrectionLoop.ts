import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SelfCorrectionError } from "../auth/Errors.ts";
import { AiService } from "../../lib/server/AiService.ts";
import { makeWorkspaceController } from "../../lib/server/WorkspaceController.ts";
import type { GitTransaction } from "../../lib/server/WorkspaceController.ts";
import type { PlanTask } from "../../lib/shared/ai-schemas.ts";

const PatchResponseSchema = z.object({
  summary: z.string().optional(),
  files: z.array(
    z.object({
      file_path: z.string(),
      code_diff: z.string(),
    })
  ),
});

export interface ICorrectionLoop {
  readonly runStep: (options: {
    readonly tx: GitTransaction;
    readonly targetFiles: readonly string[];
    readonly instructions: string;
    readonly cwd?: string;
    readonly tasks?: readonly PlanTask[];
    readonly currentTaskId?: string;
  }) => Effect.Effect<GitTransaction, SelfCorrectionError>;
}

export class CorrectionLoop extends Context.Tag("CorrectionLoop")<
  CorrectionLoop,
  ICorrectionLoop
>() {}

export const CorrectionLoopLive = Layer.effect(
  CorrectionLoop,
  Effect.gen(function* () {
    const ai = yield* AiService;

    return {
      runStep: ({ tx, targetFiles, instructions, cwd, tasks, currentTaskId }) =>
        Effect.gen(function* () {

          yield* Effect.logInfo(`[CorrectionLoop] Starting Stage 2 Self-Correction Loop for transaction: ${tx.id}`);

          const controller = makeWorkspaceController(cwd);
          const provider = tx.provider;

          let patchToApply = instructions;

          const isJson = (str: string): boolean => {
            try {
              const trimmed = str.trim();
              return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
            } catch {
              return false;
            }
          };

          if (!isJson(instructions)) {
            yield* Effect.logInfo("[CorrectionLoop] Instructions are natural language. Querying AI to generate initial patch...");
            
            let targetFilesContext = "";
            for (const file of targetFiles) {
              const filePath = cwd ? path.resolve(cwd, file) : path.resolve(file);
              const exists = yield* Effect.tryPromise({
                try: () => fs.stat(filePath).then(() => true).catch(() => false),
                catch: (e) => new SelfCorrectionError({ message: `Failed to check file stat: ${String(e)}` }),
              });

              let fileContent = "";
              if (exists) {
                fileContent = yield* Effect.tryPromise({
                  try: () => fs.readFile(filePath, "utf-8"),
                  catch: (e) => new Error(`Failed to read target file ${file}: ${String(e)}`),
                }).pipe(
                  Effect.catchAll(() => Effect.succeed(""))
                );
              }
              targetFilesContext += `File Path: ${file}\n`;
              targetFilesContext += `Current File Content:\n${fileContent || "(empty or new file)"}\n`;
              targetFilesContext += "----------------------------------------\n";
            }

            const initialPrompt = `USER TASK / FEATURE REQUEST:\n"${instructions}"\n\nHere are the target files for this task and their current content:\n${targetFilesContext}\n\nPlease generate an Aider SEARCH/REPLACE block patch that implements these requested changes. Ensure your search blocks exactly match the current content of the files.`;

            const systemPrompt = `You are Grug Code initial patch LLM.\nYour objective is to generate a precise corrective SEARCH/REPLACE block patch matching the user instructions and target files.\nRespond ONLY with a valid JSON matching the schema of SEARCH/REPLACE blocks. Do not add conversational text.`;

            const initialPatch = yield* ai.generateStructuredObject({
              system: systemPrompt,
              prompt: initialPrompt,
              schema: PatchResponseSchema,
              provider,
            }).pipe(
              Effect.mapError((err) => new SelfCorrectionError({ message: `AI initial patch generation failed: ${err.message}`, cause: err }))
            );

            patchToApply = JSON.stringify(initialPatch);
          }

          // Phase 1: Programmatically apply the initial patch
          yield* Effect.logInfo("[CorrectionLoop] Applying initial instructions patch...");
          yield* controller.applyPatch(tx, patchToApply).pipe(
            Effect.mapError((err) => new SelfCorrectionError({ message: `Failed to apply initial instructions patch: ${err.message}`, cause: err }))
          );

          let aggregateAttempts = 0;
          let verified = false;

          while (!verified) {
            // 1. Run static typecheck
            yield* Effect.logInfo(`[CorrectionLoop] Running typecheck (aggregate attempts: ${aggregateAttempts}/3)...`);
            const typecheckResult = yield* controller.runTypeCheck(tx).pipe(
              Effect.mapError((err) => new SelfCorrectionError({ message: `Typecheck execution failed: ${err.message}`, cause: err }))
            );

            if (!typecheckResult.success) {
              yield* Effect.logWarning("[CorrectionLoop] Typecheck failed. Initiating static self-correction...");

              if (aggregateAttempts >= 3) {
                yield* Effect.logError("[CorrectionLoop] Maximum aggregate correction attempts (3) reached on typecheck failure. Aborting execution.");
                return yield* Effect.fail(
                  new SelfCorrectionError({
                    message: "Stage 2 Self-Correction Loop exceeded the maximum threshold of 3 aggregate correction attempts during typecheck. Aborting step execution.",
                  })
                );
              }

              // Construct Type-First Feedback Prompt Blueprint
              let prompt = `TypeScript compilation failed with the following error output:\n\n${typecheckResult.errorOutput || "Unknown type error."}\n\n`;
              prompt += "The following currently modified (dirty) files are relevant to the failure:\n\n";

              for (const file of typecheckResult.dirtyFiles) {
                prompt += `File Path: ${file.filePath}\n`;
                prompt += `Current File Content:\n${file.content}\n`;
                prompt += "----------------------------------------\n";
              }

              prompt += "\nPlease analyze the compilation errors and generate a corrective search-and-replace block targeting only these discrepancies to restore type safety.";

              const systemPrompt = `You are Grug Code Self-Correction LLM, acting as a type-safety restorer.
Your objective is to review raw TypeScript compiler (tsc) errors, inspect the active file modifications, and generate a precise corrective patch.
Respond ONLY with a valid JSON matching the schema of SEARCH/REPLACE blocks. Do not add conversational text.`;

              yield* Effect.logInfo("[CorrectionLoop] Dispatching compilation failure context to AiService for self-healing...");
              const correction = yield* ai.generateStructuredObject({
                system: systemPrompt,
                prompt,
                schema: PatchResponseSchema,
                provider,
              }).pipe(
                Effect.mapError((err) => new SelfCorrectionError({ message: `AI Structured Object generation failed: ${err.message}`, cause: err }))
              );

              const patchPayload = JSON.stringify(correction);
              aggregateAttempts++;
              yield* Effect.logInfo(`[CorrectionLoop] Applying AI generated corrective patch (attempt ${aggregateAttempts}/3)...`);
              yield* controller.applyPatch(tx, patchPayload).pipe(
                Effect.mapError((err) => new SelfCorrectionError({ message: `Failed to apply corrective patch: ${err.message}`, cause: err }))
              );

              // Loop back immediately to recheck compilation safety
              continue;
            }

            // 2. Run static lint check
            yield* Effect.logInfo(`[CorrectionLoop] Running lint check (aggregate attempts: ${aggregateAttempts}/3)...`);
            const lintResult = yield* controller.runLintCheck(tx).pipe(
              Effect.mapError((err) => new SelfCorrectionError({ message: `Lint check execution failed: ${err.message}`, cause: err }))
            );

            if (!lintResult.success) {
              yield* Effect.logWarning("[CorrectionLoop] Lint check failed. Initiating static self-correction...");

              if (aggregateAttempts >= 3) {
                yield* Effect.logError("[CorrectionLoop] Maximum aggregate correction attempts (3) reached on lint check failure. Aborting execution.");
                return yield* Effect.fail(
                  new SelfCorrectionError({
                    message: "Stage 2 Self-Correction Loop exceeded the maximum threshold of 3 aggregate correction attempts during lint check. Aborting step execution.",
                  })
                );
              }

              // Construct Lint Feedback Prompt Blueprint
              let prompt = `Project linting failed with the following check output:\n\n${lintResult.errorOutput || "Unknown lint error."}\n\n`;
              prompt += "The following currently modified (dirty) files are relevant to the failure:\n\n";

              for (const file of lintResult.dirtyFiles) {
                prompt += `File Path: ${file.filePath}\n`;
                prompt += `Current File Content:\n${file.content}\n`;
                prompt += "----------------------------------------\n";
              }

              prompt += "\nPlease analyze the linting errors and generate a corrective search-and-replace block targeting only these discrepancies to restore clean code style.";

              const systemPrompt = `You are Grug Code Self-Correction LLM, acting as a lint restorer.
Your objective is to review linter checks output, inspect the active file modifications, and generate a precise corrective patch.
Respond ONLY with a valid JSON matching the schema of SEARCH/REPLACE blocks. Do not add conversational text.`;

              yield* Effect.logInfo("[CorrectionLoop] Dispatching lint failure context to AiService for self-healing...");
              const correction = yield* ai.generateStructuredObject({
                system: systemPrompt,
                prompt,
                schema: PatchResponseSchema,
                provider,
              }).pipe(
                Effect.mapError((err) => new SelfCorrectionError({ message: `AI Structured Object generation failed: ${err.message}`, cause: err }))
              );

              const patchPayload = JSON.stringify(correction);
              aggregateAttempts++;
              yield* Effect.logInfo(`[CorrectionLoop] Applying AI generated corrective patch (attempt ${aggregateAttempts}/3)...`);
              yield* controller.applyPatch(tx, patchPayload).pipe(
                Effect.mapError((err) => new SelfCorrectionError({ message: `Failed to apply corrective patch: ${err.message}`, cause: err }))
              );

              // Loop back immediately to verify style changes didn't break compilation
              continue;
            }

            // 3. Run behavioral test suite
            yield* Effect.logInfo(`[CorrectionLoop] Running behavioral tests (aggregate attempts: ${aggregateAttempts}/3)...`);
            const testResult = yield* controller.runTestSuite(tx).pipe(
              Effect.mapError((err) => new SelfCorrectionError({ message: `Test suite execution failed: ${err.message}`, cause: err }))
            );

            if (!testResult.success) {
              yield* Effect.logWarning("[CorrectionLoop] Behavioral test suite failed. Initiating behavioral self-correction...");

              if (aggregateAttempts >= 3) {
                yield* Effect.logError("[CorrectionLoop] Maximum aggregate correction attempts (3) reached on test suite failure. Aborting execution.");
                return yield* Effect.fail(
                  new SelfCorrectionError({
                    message: "Stage 2 Self-Correction Loop exceeded the maximum threshold of 3 aggregate correction attempts during testing. Aborting step execution.",
                  })
                );
              }

              // Construct Test-Second Feedback Prompt Blueprint
              let prompt = `Behavioral unit/E2E tests failed with the following execution output:\n\n${testResult.errorOutput || "Unknown test failure."}\n\n`;
              prompt += "The following currently modified (dirty) files are relevant to the failure:\n\n";

              for (const file of testResult.dirtyFiles) {
                prompt += `File Path: ${file.filePath}\n`;
                prompt += `Current File Content:\n${file.content}\n`;
                prompt += "----------------------------------------\n";
              }

              prompt += "\nPlease analyze the test failures and generate a corrective search-and-replace block targeting only these discrepancies to make all tests pass cleanly.";

              const systemPrompt = `You are Grug Code Self-Correction LLM, acting as a behavioral test fixer.
Your objective is to review raw test execution errors, inspect the active file modifications, and generate a precise corrective patch.
Respond ONLY with a valid JSON matching the schema of SEARCH/REPLACE blocks. Do not add conversational text.`;

              yield* Effect.logInfo("[CorrectionLoop] Dispatching test suite failure context to AiService for self-healing...");
              const correction = yield* ai.generateStructuredObject({
                system: systemPrompt,
                prompt,
                schema: PatchResponseSchema,
                provider,
              }).pipe(
                Effect.mapError((err) => new SelfCorrectionError({ message: `AI Structured Object generation failed: ${err.message}`, cause: err }))
              );

              const patchPayload = JSON.stringify(correction);
              aggregateAttempts++;
              yield* Effect.logInfo(`[CorrectionLoop] Applying AI generated corrective patch (attempt ${aggregateAttempts}/3)...`);
              yield* controller.applyPatch(tx, patchPayload).pipe(
                Effect.mapError((err) => new SelfCorrectionError({ message: `Failed to apply corrective patch: ${err.message}`, cause: err }))
              );

              // Route execution back to the Typecheck phase to verify changes didn't break compilation safety
              continue;
            }

            yield* Effect.logInfo("[CorrectionLoop] Typecheck, lint, and behavioral tests passed cleanly!");
            verified = true;
          }

          // Save checkpoint upon complete verification
          yield* Effect.logInfo("[CorrectionLoop] Saving stable Git checkpoint milestone...");
          const checkpointMessage = `self-correction success - aggregate attempts: ${aggregateAttempts}`;
          
          let updatedTasks = tasks;
          if (updatedTasks && currentTaskId) {
            updatedTasks = updatedTasks.map((t) =>
              t.id === currentTaskId ? { ...t, status: "completed" as const } : t
            );
          }

          const finalTx = yield* controller.createCheckpoint(tx, checkpointMessage, updatedTasks).pipe(
            Effect.mapError((err) => new SelfCorrectionError({ message: `Failed to save stable Git checkpoint: ${err.message}`, cause: err }))
          );

          return finalTx;
        }),
    };
  })
);

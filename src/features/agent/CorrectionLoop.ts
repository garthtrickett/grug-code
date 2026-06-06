import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import { SelfCorrectionError } from "../auth/Errors.ts";
import { AiService } from "../../lib/server/AiService.ts";
import { makeWorkspaceController } from "../../lib/server/WorkspaceController.ts";
import type { GitTransaction } from "../../lib/server/WorkspaceController.ts";

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
      runStep: ({ tx, instructions, cwd }) =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`[CorrectionLoop] Starting Stage 2 Self-Correction Loop for transaction: ${tx.id}`);

          const controller = makeWorkspaceController(cwd);

          // Phase 1: Programmatically apply the initial patch
          yield* Effect.logInfo("[CorrectionLoop] Applying initial instructions patch...");
          yield* controller.applyPatch(tx, instructions).pipe(
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

            yield* Effect.logInfo("[CorrectionLoop] Typecheck passed. Running behavioral tests...");

            // 2. Run behavioral test suite
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

            yield* Effect.logInfo("[CorrectionLoop] Both typecheck and behavioral tests passed cleanly!");
            verified = true;
          }

          // Save checkpoint upon complete verification
          yield* Effect.logInfo("[CorrectionLoop] Saving stable Git checkpoint milestone...");
          const checkpointMessage = `self-correction success - aggregate attempts: ${aggregateAttempts}`;
          const finalTx = yield* controller.createCheckpoint(tx, checkpointMessage).pipe(
            Effect.mapError((err) => new SelfCorrectionError({ message: `Failed to save stable Git checkpoint: ${err.message}`, cause: err }))
          );

          return finalTx;
        }),
    };
  })
);

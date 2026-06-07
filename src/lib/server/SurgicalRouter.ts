import { Context, Effect, Layer } from "effect";
import { TokenEstimator } from "./TokenEstimator.ts";
import { config } from "./Config.ts";

export type ExecutionRoute =
  | { readonly path: "DIRECT" }
  | { readonly path: "SURGICAL"; readonly reason: string };

export interface ISurgicalRouter {
  readonly routeExecution: (
    filePaths: readonly string[]
  ) => Effect.Effect<ExecutionRoute, Error>;
}

export class SurgicalRouter extends Context.Tag("SurgicalRouter")<
  SurgicalRouter,
  ISurgicalRouter
>() {}

export const SurgicalRouterLive = Layer.effect(
  SurgicalRouter,
  Effect.gen(function* () {
    const estimator = yield* TokenEstimator;

    return {
      routeExecution: (filePaths: readonly string[]) =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`[SurgicalRouter] Starting routeExecution for paths: ${JSON.stringify(filePaths)}`);
          yield* Effect.logInfo(`[SurgicalRouter] Configured limits - fileLimit: ${config.surgical.fileLimit} (type: ${typeof config.surgical.fileLimit}), tokenLimit: ${config.surgical.tokenLimit} (type: ${typeof config.surgical.tokenLimit})`);

          if (filePaths.length === 0) {
            yield* Effect.logWarning("[SurgicalRouter] Validation failed: target files array is empty");
            return yield* Effect.fail(
              new Error("Validation error: target files array cannot be empty.")
            );
          }

          if (filePaths.length > config.surgical.fileLimit) {
            const reason = `File count exceeds the direct routing threshold (Count: ${filePaths.length}, Limit: ${config.surgical.fileLimit}).`;
            yield* Effect.logInfo(`[SurgicalRouter] Routing to SURGICAL. Reason: ${reason}`);
            return {
              path: "SURGICAL" as const,
              reason,
            };
          }

          yield* Effect.logInfo(`[SurgicalRouter] File count ${filePaths.length} is within limit ${config.surgical.fileLimit}. Proceeding to estimate token size...`);
          const totalTokens = yield* estimator.estimateTotalTokens(filePaths);
          yield* Effect.logInfo(`[SurgicalRouter] Estimated total tokens: ${totalTokens} vs limit: ${config.surgical.tokenLimit}`);

          if (totalTokens > config.surgical.tokenLimit) {
            const reason = `Aggregate token size exceeds direct budget of ${config.surgical.tokenLimit.toLocaleString("en-US")} tokens (Estimated: ${totalTokens}, Limit: ${config.surgical.tokenLimit}).`;
            yield* Effect.logInfo(`[SurgicalRouter] Routing to SURGICAL. Reason: ${reason}`);
            return {
              path: "SURGICAL" as const,
              reason,
            };
          }

          yield* Effect.logInfo("[SurgicalRouter] Routing to DIRECT");
          return {
            path: "DIRECT" as const,
          };
        }),
    };
  })
);

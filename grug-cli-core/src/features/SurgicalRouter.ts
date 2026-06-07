import { Context, Effect, Layer } from "effect";
import { TokenEstimator } from "../lib/TokenEstimator.ts";
import { config } from "../lib/Config.ts";

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

          if (filePaths.length === 0) {
            return yield* Effect.fail(
              new Error("Validation error: target files array cannot be empty.")
            );
          }

          if (filePaths.length > config.surgical.fileLimit) {
            const reason = `File count exceeds the direct routing threshold (Count: ${filePaths.length}, Limit: ${config.surgical.fileLimit}).`;
            return {
              path: "SURGICAL" as const,
              reason,
            };
          }

          const totalTokens = yield* estimator.estimateTotalTokens(filePaths);

          if (totalTokens > config.surgical.tokenLimit) {
            const reason = `Aggregate token size exceeds direct budget of ${config.surgical.tokenLimit.toLocaleString("en-US")} tokens (Estimated: ${totalTokens}, Limit: ${config.surgical.tokenLimit}).`;
            return {
              path: "SURGICAL" as const,
              reason,
            };
          }

          return {
            path: "DIRECT" as const,
          };
        }),
    };
  })
);
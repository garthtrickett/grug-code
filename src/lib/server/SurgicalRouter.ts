import { Context, Effect, Layer } from "effect";
import { TokenEstimator } from "./TokenEstimator";

export type ExecutionRoute =
  | { readonly path: "DIRECT" }
  | { readonly path: "SURGICAL"; readonly reason: string };

export interface SurgicalRouter {
  readonly routeExecution: (
    filePaths: readonly string[]
  ) => Effect.Effect<ExecutionRoute, Error>;
}

export const SurgicalRouter = Context.Tag<SurgicalRouter>("SurgicalRouter");

export const SurgicalRouterLive = Layer.effect(
  SurgicalRouter,
  Effect.gen(function* () {
    const estimator = yield* TokenEstimator;

    return {
      routeExecution: (filePaths: readonly string[]) =>
        Effect.gen(function* () {
          if (filePaths.length === 0) {
            return yield* Effect.fail(
              new Error("Validation error: target files array cannot be empty.")
            );
          }

          if (filePaths.length > 3) {
            return {
              path: "SURGICAL" as const,
              reason: `File count exceeds the direct routing threshold (Count: ${filePaths.length}, Limit: 3).`,
            };
          }

          const totalTokens = yield* estimator.estimateTotalTokens(filePaths);

          if (totalTokens > 20000) {
            return {
              path: "SURGICAL" as const,
              reason: `Aggregate token size exceeds direct budget of 20,000 tokens (Estimated: ${totalTokens}, Limit: 20000).`,
            };
          }

          return {
            path: "DIRECT" as const,
          };
        }),
    };
  })
);

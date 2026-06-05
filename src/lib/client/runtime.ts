import { Effect, Layer, Runtime, Scope, Exit } from "effect";
import { LocationLive, LocationService } from "./LocationService";

export type BaseClientContext = LocationService;

export const BaseClientLive = Layer.mergeAll(LocationLive);

const appScope = Effect.runSync(Scope.make());

export const AppRuntime = Effect.runSync(
  Scope.extend(Layer.toRuntime(BaseClientLive), appScope),
);

export const clientRuntime: Runtime.Runtime<BaseClientContext> =
  AppRuntime;

export const runClientPromise = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => {
  return Runtime.runPromise(clientRuntime)(effect as unknown as Effect.Effect<A, E, BaseClientContext>);
};

export const runClientUnscoped = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => {
  return Runtime.runFork(clientRuntime)(effect as unknown as Effect.Effect<A, E, BaseClientContext>);
};

export const shutdownClient = () =>
  Effect.runPromise(Scope.close(appScope, Exit.succeed(undefined)));



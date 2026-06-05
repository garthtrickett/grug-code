import { ManagedRuntime, Layer } from "effect";
import { ObservabilityLive } from "./observability";

export const ServerLive = Layer.mergeAll(
  ObservabilityLive
);

export const serverRuntime = ManagedRuntime.make(ServerLive);

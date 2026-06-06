import { ManagedRuntime, Layer } from "effect";
import { ObservabilityLive } from "./observability";
import { AiServiceLive } from "./AiService.ts";

export const ServerLive = Layer.mergeAll(
  ObservabilityLive,
  AiServiceLive
);

export const serverRuntime = ManagedRuntime.make(ServerLive);

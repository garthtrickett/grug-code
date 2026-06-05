import { randomBytes } from "node:crypto";
import { Effect } from "effect";

export const getRandomBytes = (length: number) =>
  Effect.sync(() => randomBytes(length));

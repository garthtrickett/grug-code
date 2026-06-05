import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { getRandomBytes } from "./crypto";

export const generateUUID = (): Effect.Effect<string> =>
  Effect.sync(() => randomUUID());

export const generateId = (
  length: number,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const buffer = yield* getRandomBytes(Math.ceil(length / 2));
    return buffer.toString("hex").slice(0, length);
  });

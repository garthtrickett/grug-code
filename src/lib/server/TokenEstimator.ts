import { Context, Effect, Layer } from "effect";
import * as fs from "node:fs/promises";

export interface ITokenEstimator {
  readonly estimateStringTokens: (content: string) => Effect.Effect<number, never>;
  readonly estimateTokens: (filePath: string) => Effect.Effect<number, Error>;
  readonly estimateTotalTokens: (filePaths: readonly string[]) => Effect.Effect<number, Error>;
  readonly logTokenUsage: (taskId: string, phase: string, count: number) => Effect.Effect<void, never>;
}

export class TokenEstimator extends Context.Tag("TokenEstimator")<
  TokenEstimator,
  ITokenEstimator
>() {
  public static readonly tokenUsageMap = new Map<string, Record<string, number>>();

  public static logTokenUsage(taskId: string, phase: string, count: number): void {
    const existing = this.tokenUsageMap.get(taskId) || {};
    existing[phase] = (existing[phase] || 0) + count;
    this.tokenUsageMap.set(taskId, existing);
    console.info("[TokenEstimator] Logged token usage: taskId=" + taskId + ", phase=" + phase + ", count=" + count);
  }
}

/**
 * A highly efficient and deterministic token estimator that closely approximates
 * OpenAI's cl100k_base pre-tokenization and BPE merging behaviors locally.
 */
export const countTokens = (text: string): number => {
  if (!text) return 0;

  let total = 0;
  const matches = text.match(/'s|'t|'re|'ve|'m|'ll|'d|[a-zA-Z0-9]+|[^\x00-\x7F]+|[^a-zA-Z0-9\s\x00-\x7F]+|\s+/g);
  if (!matches) return 0;

  for (const match of matches) {
    if (/^\s+$/.test(match)) {
      const newlines = (match.match(/\n/g) || []).length;
      if (newlines > 0) {
        total += newlines;
        const lastLineIndent = match.split("\n").pop() || "";
        if (lastLineIndent.length > 0) {
          total += Math.ceil(lastLineIndent.length / 4);
        }
      } else {
        total += Math.ceil(match.length / 4);
      }
    } else if (/^[a-zA-Z0-9]+$/.test(match)) {
      if (match.length <= 5) {
        total += 1;
      } else {
        total += Math.ceil(match.length / 3.5);
      }
    } else if (/^[^\x00-\x7F]+$/.test(match)) {
      total += Math.ceil(match.length * 1.2);
    } else {
      if (match.length <= 2) {
        total += 1;
      } else {
        total += Math.ceil(match.length / 2);
      }
    }
  }

  return total;
};

export const TokenEstimatorLive = Layer.succeed(
  TokenEstimator,
  TokenEstimator.of({
    estimateStringTokens: (content: string) =>
      Effect.sync(() => {
        const count = countTokens(content);
        return count;
      }),

    estimateTokens: (filePath: string) =>
      Effect.gen(function* () {
        const text = yield* Effect.tryPromise({
          try: () => fs.readFile(filePath, "utf-8"),
          catch: (e) => new Error(`Failed to read file for token estimation: ${String(e)}`),
        }).pipe(Effect.catchAll(() => Effect.succeed("")));
        return countTokens(text);
      }),

    estimateTotalTokens: (filePaths: readonly string[]) =>
      Effect.gen(function* () {
        let total = 0;
        for (const filePath of filePaths) {
          const content = yield* Effect.tryPromise({ 
            try: () => fs.readFile(filePath, "utf-8"),
            catch: (e) => new Error(`Failed to read file ${filePath} for token estimation: ${String(e)}`),
          }).pipe(Effect.catchAll(() => Effect.succeed("")));
          total += countTokens(content);
        }
        return total;
      }),

    logTokenUsage: (taskId: string, phase: string, count: number) =>
      Effect.sync(() => {
        TokenEstimator.logTokenUsage(taskId, phase, count);
      }),
  })
);

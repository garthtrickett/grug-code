import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TokenEstimator, TokenEstimatorLive, countTokens } from "./TokenEstimator";

describe("TokenEstimator - Local BPE Heuristics", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), `.grug-token-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should estimate simple JavaScript code strings accurately", () => {
    const code = "const a = 123;";
    const count = countTokens(code);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it("should estimate multiple newlines and spaces conservatively", () => {
    const spaces = "    \n        \n    ";
    const count = countTokens(spaces);
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it("should handle non-ASCII/CJK characters conservatively", () => {
    const text = "こんにちは日本語";
    const count = countTokens(text);
    expect(count).toBe(Math.ceil(8 * 1.2));
  });

  it("should run successfully as an Effect service with TokenEstimatorLive", async () => {
    const file1 = path.join(tempDir, "test1.ts");
    const file2 = path.join(tempDir, "test2.json");

    await fs.writeFile(file1, "export const value = 42;\n");
    await fs.writeFile(file2, JSON.stringify({ name: "grug", count: 123 }));

    const program = Effect.gen(function* () { const estimator = yield* TokenEstimator;

      const stringCount = yield* estimator.estimateStringTokens("simple text test");
      expect(stringCount).toBe(5);

      const count1 = yield* estimator.estimateTokens(file1);
      const count2 = yield* estimator.estimateTokens(file2);
      expect(count1).toBeGreaterThan(0);
      expect(count2).toBeGreaterThan(0);

      const total = yield* estimator.estimateTotalTokens([file1, file2]);
      expect(total).toBe(count1 + count2);
    }).pipe(Effect.provide(TokenEstimatorLive));

    await Effect.runPromise(program);
  });
});

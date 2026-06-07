import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { makeCommandRunner, parseTscErrors, parseTestFailures } from "./CommandRunner";

describe("CommandRunner - Execution and Spawner System", () => {
  it("should execute clean inline shell tasks successfully", async () => {
    const runner = makeCommandRunner();
    const runProgram = runner.run(["bun", "-e", "console.log('hello world')"]);

    const result = await Effect.runPromise(runProgram);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.timedOut).toBe(false);
  });

  it("should correctly capture non-zero exit codes on program failure", async () => {
    const runner = makeCommandRunner();
    const runProgram = runner.run(["bun", "-e", "process.exit(42)"]);

    const result = await Effect.runPromise(runProgram);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it("should run custom commands when provided in runTypeCheck, runLintCheck and runTestSuite", async () => {
    const runner = makeCommandRunner();
    
    const tcResult = await Effect.runPromise(runner.runTypeCheck(undefined, 10000, "echo tc-custom"));
    expect(tcResult.success).toBe(true);

    const lcResult = await Effect.runPromise(runner.runLintCheck(undefined, 10000, "echo lint-custom"));
    expect(lcResult.success).toBe(true);

    const tsResult = await Effect.runPromise(runner.runTestSuite(undefined, 10000, "echo test-custom"));
    expect(tsResult.success).toBe(true);
  });

  it("should enforce timeout budgets strictly and kill hung commands", async () => {
    const runner = makeCommandRunner();
    const runProgram = runner.run(
      ["bun", "-e", "setTimeout(() => console.log('should not print'), 5000)"],
      { timeoutMs: 150 }
    );

    const result = await Effect.runPromise(runProgram);
    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("should support custom environment overrides", async () => {
    const runner = makeCommandRunner();
    const runProgram = runner.run(
      ["bun", "-e", "console.log(process.env.DATABASE_URL_TEST_VALUE)"],
      { env: { DATABASE_URL_TEST_VALUE: "grug-pool-override-url" } }
    );

    const result = await Effect.runPromise(runProgram);
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe("grug-pool-override-url");
  });

  it("should parse standard tsc compiler error logs accurately", () => {
    const tscLog = `
src/lib/client/stores/hlcStore.ts(12,35): error TS2304: Cannot find name 'crypto'.
src/components/DictionaryPopover.ts:45:22 - error TS2554: Expected 2 arguments, but got 1.
`;
    const parsed = parseTscErrors(tscLog);
    expect(parsed).toContain("src/lib/client/stores/hlcStore.ts");
    expect(parsed).toContain("src/components/DictionaryPopover.ts");
    expect(parsed.length).toBe(2);
  });

  it("should parse standard test framework files from failure dumps", () => {
    const testLog = `
✗ src/components/DictionaryPopover.test.ts > state transitions [2.40ms]
FAIL  tests/e2e/dictionary-lookup.spec.ts
`;
    const parsed = parseTestFailures(testLog);
    expect(parsed).toContain("src/components/DictionaryPopover.test.ts");
    expect(parsed).toContain("tests/e2e/dictionary-lookup.spec.ts");
    expect(parsed.length).toBe(2);
  });
});

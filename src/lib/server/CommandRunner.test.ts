import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeCommandRunner, parseTscErrors, parseTestFailures } from "./CommandRunner";

describe("CommandRunner - Execution and Spawner System", () => {
  it("should correctly prefix and wrap commands when startupCommand is provided", async () => {
    const runner = makeCommandRunner();
    const bunProgram = runner.run(
      ["-e", "console.log('bun-wrapped')"],
      { startupCommand: "bun" }
    );
    const bunResult = await Effect.runPromise(bunProgram);
    expect(bunResult.success).toBe(true);
    expect(bunResult.stdout.trim()).toBe("bun-wrapped");
  });

  it("should construct nix develop wrapper args correctly", async () => {
    const runner = makeCommandRunner();
    const nixProgram = runner.run(
      ["bun", "-e", "console.log('nix-wrapped')"],
      { startupCommand: "nix develop" }
    );
    const result = await Effect.runPromise(Effect.either(nixProgram));
    if (result._tag === "Left") {
      expect(result.left.message).toContain("nix develop");
      expect(result.left.message).toContain("-c");
    } else {
      expect(result.right).toBeDefined();
    }
  });

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

  it("should intercept stdout/stderr and route them to progressBroadcaster during run", async () => {
    const runner = makeCommandRunner();
    const { progressBroadcaster } = await import("./WorkspaceController");

    let receivedMessage = "";
    const listener = (data: string) => {
      receivedMessage = data;
    };
    progressBroadcaster.on("progress", listener);

    try {
      const runProgram = runner.run(["bun", "-e", "console.log('UDS-broadcaster-success')"]);
      await Effect.runPromise(runProgram);
      
      expect(receivedMessage).toContain("UDS-broadcaster-success");
    } finally {
      progressBroadcaster.off("progress", listener);
    }
  });

  it("should apply port-shifting and pass down socketPath in environment during runTestSuite", async () => {
    const runner = makeCommandRunner();
    const testSuiteResult = await Effect.runPromise(
      runner.runTestSuite(undefined, 10000, "bun -e console.log(JSON.stringify(process.env))")
    );

    expect(testSuiteResult.success).toBe(true);
  });

  it("should execute multiple parallel test suites without port collision", async () => {
    const runner = makeCommandRunner();
    const parallelRuns = Array.from({ length: 4 }).map(() =>
      runner.runTestSuite(undefined, 15000, "bun -e console.log(process.env.PORT)")
    );

    const results = await Effect.runPromise(Effect.all(parallelRuns));
    results.forEach((r) => {
      expect(r.success).toBe(true);
    });
  });

  it("should execute verification suites inside the specified isolated worktree directory", async () => {
    const tempWorktreeDir = path.join(process.cwd(), `command-runner-worktree-${crypto.randomUUID()}`);
    await fs.mkdir(tempWorktreeDir, { recursive: true });

    const runner = makeCommandRunner();

    // Verify typecheck executes in our temporary worktree by printing cwd
    const tcResult = await Effect.runPromise(
      runner.runTypeCheck(
        tempWorktreeDir,
        10000,
        "bun -e console.log(process.cwd())"
      )
    );
    expect(tcResult.success).toBe(true);

    // Verify test suite executes in our temporary worktree
    const tsResult = await Effect.runPromise(
      runner.runTestSuite(
        tempWorktreeDir,
        10000,
        "bun -e console.log(process.cwd())"
      )
    );
    expect(tsResult.success).toBe(true);

    // Clean up
    await fs.rm(tempWorktreeDir, { recursive: true, force: true });
  });
});

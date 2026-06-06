import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { CorrectionLoop, CorrectionLoopLive } from "./CorrectionLoop.ts";
import { AiService } from "../../lib/server/AiService.ts";
import type { GitTransaction } from "../../lib/server/WorkspaceController.ts";

const mockApplyPatch = vi.fn();
const mockRunTypeCheck = vi.fn();
const mockRunTestSuite = vi.fn();
const mockCreateCheckpoint = vi.fn();

vi.mock("../../lib/server/WorkspaceController.ts", () => {
  return {
    makeWorkspaceController: () => ({
      initTransaction: vi.fn(),
      applyPatch: (...args: any[]) => mockApplyPatch(...args),
      runTypeCheck: (...args: any[]) => mockRunTypeCheck(...args),
      runTestSuite: (...args: any[]) => mockRunTestSuite(...args),
      createCheckpoint: (...args: any[]) => mockCreateCheckpoint(...args),
      rollbackToCheckpoint: vi.fn(),
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn(),
      listDirectories: vi.fn(),
    }),
  };
});

const mockGenerateStructuredObject = vi.fn();

const aiServiceMock = Layer.succeed(
  AiService,
  AiService.of({
    generateStructuredObject: (...args: any[]) => mockGenerateStructuredObject(...args),
    streamText: vi.fn(),
  })
);

describe("CorrectionLoop - Stage 2 Type-First Self-Correction Loop", () => {
  const dummyTx: GitTransaction = {
    id: "test-correction-tx",
    baseBranch: "main",
    ephemeralBranch: "grug-task/test-correction-tx",
    checkpoints: [],
    provider: "openai",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should exit successfully on immediate typecheck success without invoking AI", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    mockRunTypeCheck.mockReturnValue(
      Effect.succeed({
        success: true,
        dirtyFiles: [],
      })
    );
    mockRunTestSuite.mockReturnValue(
      Effect.succeed({
        success: true,
        dirtyFiles: [],
      })
    );
    mockCreateCheckpoint.mockImplementation((tx) => Effect.succeed(tx));

    const program = Effect.flatMap(CorrectionLoop, (loop) =>
      loop.runStep({
        tx: dummyTx,
        targetFiles: ["src/math.ts"],
        instructions: JSON.stringify({ files: [] }),
      })
    ).pipe(
      Effect.provide(CorrectionLoopLive),
      Effect.provide(aiServiceMock)
    );

    const result = await Effect.runPromise(program);
    expect(result).toEqual(dummyTx);
        expect(mockApplyPatch).toHaveBeenCalledTimes(1);
    expect(mockRunTypeCheck).toHaveBeenCalledTimes(1);
    expect(mockRunTestSuite).toHaveBeenCalledTimes(1);
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(dummyTx, "self-correction success - aggregate attempts: 0", undefined);
  });

  it("should self-heal compilation failure on first attempt and succeed on second attempt", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    mockRunTestSuite.mockReturnValue(
      Effect.succeed({
        success: true,
        dirtyFiles: [],
      })
    );
    mockCreateCheckpoint.mockImplementation((tx) => Effect.succeed(tx));
    
    // First run fails, second succeeds
    mockRunTypeCheck
      .mockReturnValueOnce(
        Effect.succeed({
          success: false,
          errorOutput: "TS2322: Type 'string' is not assignable to type 'number'.",
          dirtyFiles: [
            {
              filePath: "src/math.ts",
              content: "const x: number = 'hello';",
            },
          ],
        })
      )
      .mockReturnValueOnce(
        Effect.succeed({
          success: true,
          dirtyFiles: [],
        })
      );

    mockGenerateStructuredObject.mockReturnValue(
      Effect.succeed({
        summary: "Fix string assignment to number",
        files: [
          {
            file_path: "src/math.ts",
            code_diff: "<<<<<<< SEARCH\nconst x: number = 'hello';\n=======\nconst x: number = 42;\n>>>>>>> REPLACE",
          },
        ],
      })
    );

    const program = Effect.flatMap(CorrectionLoop, (loop) =>
      loop.runStep({
        tx: dummyTx,
        targetFiles: ["src/math.ts"],
        instructions: JSON.stringify({ files: [] }),
      })
    ).pipe(
      Effect.provide(CorrectionLoopLive),
      Effect.provide(aiServiceMock)
    );

    const result = await Effect.runPromise(program);
    expect(result).toEqual(dummyTx);
    expect(mockApplyPatch).toHaveBeenCalledTimes(2); // Initial patch + 1 corrective patch
    expect(mockRunTypeCheck).toHaveBeenCalledTimes(2);
    expect(mockGenerateStructuredObject).toHaveBeenCalledTimes(1);
        expect(mockGenerateStructuredObject).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" })
    );
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(dummyTx, "self-correction success - aggregate attempts: 1", undefined);
  });

  it("should fail and raise SelfCorrectionError when three consecutive compilation failures occur", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    
    // Fail consistently
    mockRunTypeCheck.mockReturnValue(
      Effect.succeed({
        success: false,
        errorOutput: "Static analysis remains broken.",
        dirtyFiles: [],
      })
    );

    mockGenerateStructuredObject.mockReturnValue(
      Effect.succeed({
        files: [],
      })
    );

    const program = Effect.flatMap(CorrectionLoop, (loop) =>
      loop.runStep({
        tx: dummyTx,
        targetFiles: ["src/math.ts"],
        instructions: JSON.stringify({ files: [] }),
      })
    ).pipe(
      Effect.provide(CorrectionLoopLive),
      Effect.provide(aiServiceMock)
    );

    const result = await Effect.runPromise(Effect.either(program));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const err = result.left;
      expect(err._tag).toBe("SelfCorrectionError");
      expect(err.message).toContain("exceeded the maximum threshold of 3 aggregate correction attempts during typecheck");
    }

    // Verify exactly 4 typechecks were performed, and 3 corrections were applied before aborting on the 4th check fail
    expect(mockRunTypeCheck).toHaveBeenCalledTimes(4);
    expect(mockApplyPatch).toHaveBeenCalledTimes(4); // Initial patch + 3 corrective patches
    expect(mockGenerateStructuredObject).toHaveBeenCalledTimes(3);
    expect(mockGenerateStructuredObject).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "openai" })
    );
    expect(mockCreateCheckpoint).not.toHaveBeenCalled();
  });

  it("should compile successfully, fail behavioral tests, apply patch that breaks compilation, apply second patch resolving both, and save checkpoint", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    mockCreateCheckpoint.mockImplementation((tx) => Effect.succeed(tx));

    // Typecheck calls:
    // 1st: succeeds
    // 2nd: fails (test correction broke type safety!)
    // 3rd: succeeds
    mockRunTypeCheck
      .mockReturnValueOnce(Effect.succeed({ success: true, dirtyFiles: [] }))
      .mockReturnValueOnce(Effect.succeed({ success: false, errorOutput: "TS2304: Cannot find name 'brokenVar'", dirtyFiles: [] }))
      .mockReturnValueOnce(Effect.succeed({ success: true, dirtyFiles: [] }));

    // Test suite calls:
    // 1st: fails
    // 2nd: succeeds
    mockRunTestSuite
      .mockReturnValueOnce(Effect.succeed({ success: false, errorOutput: "Assertion failed: expected 10 but got 5", dirtyFiles: [] }))
      .mockReturnValueOnce(Effect.succeed({ success: true, dirtyFiles: [] }));

    // AI correction responses:
    // 1st response (correcting test failure, but introduces broken compiler variable):
    // 2nd response (correcting static compiler error, type safety restored):
    mockGenerateStructuredObject
      .mockReturnValueOnce(
        Effect.succeed({
          summary: "Fix test failure but break compilation",
          files: [{ file_path: "src/math.ts", code_diff: "SEARCH/REPLACE" }]
        })
      )
      .mockReturnValueOnce(
        Effect.succeed({
          summary: "Restore type safety and pass tests",
          files: [{ file_path: "src/math.ts", code_diff: "SEARCH/REPLACE" }]
        })
      );

    const program = Effect.flatMap(CorrectionLoop, (loop) =>
      loop.runStep({
        tx: dummyTx,
        targetFiles: ["src/math.ts"],
        instructions: JSON.stringify({ files: [] }),
      })
    ).pipe(
      Effect.provide(CorrectionLoopLive),
      Effect.provide(aiServiceMock)
    );

    const result = await Effect.runPromise(program);
    expect(result).toEqual(dummyTx);

    // Verify execution steps
    expect(mockRunTypeCheck).toHaveBeenCalledTimes(3);
    expect(mockRunTestSuite).toHaveBeenCalledTimes(2);
        expect(mockGenerateStructuredObject).toHaveBeenCalledTimes(2);
    expect(mockApplyPatch).toHaveBeenCalledTimes(3); // Initial patch + 1 test-correction patch + 1 compile-correction patch
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(dummyTx, "self-correction success - aggregate attempts: 2", undefined);
  });

  it("should preserve original stable state and halt safely when aggregate correction threshold is exhausted during the test phase", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);

    // Typecheck always passes
    mockRunTypeCheck.mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));

    // Test suite fails constantly
    mockRunTestSuite.mockReturnValue(
      Effect.succeed({
        success: false,
        errorOutput: "Behavioral test failing continuously.",
        dirtyFiles: [],
      })
    );

    // AI is queried to fix tests
    mockGenerateStructuredObject.mockReturnValue(
      Effect.succeed({
        files: [],
      })
    );

    const program = Effect.flatMap(CorrectionLoop, (loop) =>
      loop.runStep({
        tx: dummyTx,
        targetFiles: ["src/math.ts"],
        instructions: JSON.stringify({ files: [] }),
      })
    ).pipe(
      Effect.provide(CorrectionLoopLive),
      Effect.provide(aiServiceMock)
    );

    const result = await Effect.runPromise(Effect.either(program));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const err = result.left;
      expect(err._tag).toBe("SelfCorrectionError");
      expect(err.message).toContain("exceeded the maximum threshold of 3 aggregate correction attempts during testing");
    }

    // Verify executions:
    // - Initial check: typecheck succeeds (1), test fails (1) -> correction 1
    // - Round 2: typecheck succeeds (2), test fails (2) -> correction 2
    // - Round 3: typecheck succeeds (3), test fails (3) -> correction 3
    // - Round 4: typecheck succeeds (4), test fails (4) -> attempts is now 3, we abort before applying the 4th correction!
    expect(mockRunTypeCheck).toHaveBeenCalledTimes(4);
    expect(mockRunTestSuite).toHaveBeenCalledTimes(4);
    expect(mockGenerateStructuredObject).toHaveBeenCalledTimes(3);
    expect(mockApplyPatch).toHaveBeenCalledTimes(4); // Initial patch + 3 corrective patches
    expect(mockCreateCheckpoint).not.toHaveBeenCalled();
  });
});

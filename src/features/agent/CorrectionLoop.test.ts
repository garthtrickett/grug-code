import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { CorrectionLoop, CorrectionLoopLive } from "./CorrectionLoop.ts";
import { AiService } from "../../lib/server/AiService.ts";
import { broadcastProgress } from "../../lib/server/mcp/McpServer.ts";
import type { GitTransaction } from "../../lib/server/WorkspaceController.ts";

const mockApplyPatch = vi.fn();
const mockRunTypeCheck = vi.fn();
const mockRunLintCheck = vi.fn();
const mockRunTestSuite = vi.fn();
const mockCreateCheckpoint = vi.fn();
const mockCreateWorktree = vi.fn();
const mockDeleteWorktree = vi.fn();

vi.mock("../../lib/server/WorkspaceController.ts", () => {
  return {
    makeWorkspaceController: () => ({
      initTransaction: vi.fn(),
      applyPatch: (...args: any[]) => mockApplyPatch(...args),
      runTypeCheck: (...args: any[]) => mockRunTypeCheck(...args),
      runLintCheck: (...args: any[]) => mockRunLintCheck(...args),
      runTestSuite: (...args: any[]) => mockRunTestSuite(...args),
      createCheckpoint: (...args: any[]) => mockCreateCheckpoint(...args),
      rollbackToCheckpoint: vi.fn(),
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn(),
      listDirectories: vi.fn(),
      createWorktree: (...args: any[]) => mockCreateWorktree(...args),
      deleteWorktree: (...args: any[]) => mockDeleteWorktree(...args),
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

vi.mock("../../lib/server/mcp/McpServer.ts", () => {
  return {
    broadcastProgress: vi.fn(),
    mcpTransports: new Map(),
  };
});

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
    mockCreateWorktree.mockReturnValue(Effect.succeed("/mock/worktree/path"));
    mockDeleteWorktree.mockReturnValue(Effect.void);
  });

    it("should broadcast progress notifications during step verification", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    mockRunTypeCheck.mockImplementation((tx, onStdout) => {
      if (onStdout) onStdout("compiling src/math.ts...");
      return Effect.succeed({ success: true, dirtyFiles: [] });
    });
    mockRunLintCheck.mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));
    mockRunTestSuite.mockImplementation((tx, onStdout) => {
      if (onStdout) onStdout("running math tests...");
      return Effect.succeed({ success: true, dirtyFiles: [] });
    });
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

    await Effect.runPromise(program);

    expect(broadcastProgress).toHaveBeenCalled();
    expect(broadcastProgress).toHaveBeenCalledWith(
      dummyTx.id,
      "compiling src/math.ts...",
      expect.any(Number)
    );
    expect(broadcastProgress).toHaveBeenCalledWith(
      dummyTx.id,
      "running math tests...",
      expect.any(Number)
    );
  });

  it("should exit successfully on immediate typecheck success without invoking AI", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    mockRunTypeCheck.mockReturnValue(
      Effect.succeed({
        success: true,
        dirtyFiles: [],
      })
    );
    mockRunLintCheck.mockReturnValue(
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
    expect(mockRunLintCheck).toHaveBeenCalledTimes(1);
    expect(mockRunTestSuite).toHaveBeenCalledTimes(1);
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(dummyTx, "self-correction success - aggregate attempts: 0", undefined);
    expect(mockCreateWorktree).toHaveBeenCalledWith(dummyTx);
    expect(mockDeleteWorktree).toHaveBeenCalledWith(dummyTx);
  });

  it("should self-heal compilation failure on first attempt and succeed on second attempt", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    mockRunLintCheck.mockReturnValue(
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
    expect(mockApplyPatch).toHaveBeenCalledTimes(2); 
    expect(mockRunTypeCheck).toHaveBeenCalledTimes(2);
    expect(mockGenerateStructuredObject).toHaveBeenCalledTimes(1);
    expect(mockGenerateStructuredObject).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" })
    );
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(dummyTx, "self-correction success - aggregate attempts: 1", undefined);
    expect(mockCreateWorktree).toHaveBeenCalledWith(dummyTx);
    expect(mockDeleteWorktree).toHaveBeenCalledWith(dummyTx);
  });

  it("should succeed when compilation passes but linting fails on first check, applying corrective patch, verifying compiler, and checkpointing", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    
    mockRunTypeCheck.mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));

    mockRunLintCheck
      .mockReturnValueOnce(
        Effect.succeed({
          success: false,
          errorOutput: "Eslint: Semi-colon missing in src/math.ts:3",
          dirtyFiles: [
            {
              filePath: "src/math.ts",
              content: "const x = 42",
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

    mockRunTestSuite.mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));
    mockCreateCheckpoint.mockImplementation((tx) => Effect.succeed(tx));

    mockGenerateStructuredObject.mockReturnValue(
      Effect.succeed({
        summary: "Fix missing semi-colon",
        files: [
          {
            file_path: "src/math.ts",
            code_diff: "<<<<<<< SEARCH\nconst x = 42\n=======\nconst x = 42;\n>>>>>>> REPLACE",
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

    expect(mockRunTypeCheck).toHaveBeenCalledTimes(2); 
    expect(mockRunLintCheck).toHaveBeenCalledTimes(2);
    expect(mockRunTestSuite).toHaveBeenCalledTimes(1);
    expect(mockApplyPatch).toHaveBeenCalledTimes(2); 
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(dummyTx, "self-correction success - aggregate attempts: 1", undefined);
    expect(mockCreateWorktree).toHaveBeenCalledWith(dummyTx);
    expect(mockDeleteWorktree).toHaveBeenCalledWith(dummyTx);
  });

  it("should fail and raise SelfCorrectionError when three consecutive compilation failures occur, preserving the worktree for diagnostics", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    
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
      expect(err.message).toContain("Worktree preserved at:");
    }

    expect(mockRunTypeCheck).toHaveBeenCalledTimes(4);
    expect(mockApplyPatch).toHaveBeenCalledTimes(4); 
    expect(mockGenerateStructuredObject).toHaveBeenCalledTimes(3);
    expect(mockCreateCheckpoint).not.toHaveBeenCalled();
    expect(mockCreateWorktree).toHaveBeenCalledWith(dummyTx);
    expect(mockDeleteWorktree).not.toHaveBeenCalled();
  });

  it("should compile successfully, fail behavioral tests, apply patch that breaks compilation, apply second patch resolving both, and save checkpoint", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    mockCreateCheckpoint.mockImplementation((tx) => Effect.succeed(tx));
    mockRunLintCheck.mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));

    mockRunTypeCheck
      .mockReturnValueOnce(Effect.succeed({ success: true, dirtyFiles: [] }))
      .mockReturnValueOnce(Effect.succeed({ success: false, errorOutput: "TS2304: Cannot find name 'brokenVar'", dirtyFiles: [] }))
      .mockReturnValueOnce(Effect.succeed({ success: true, dirtyFiles: [] }));

    mockRunTestSuite
      .mockReturnValueOnce(Effect.succeed({ success: false, errorOutput: "Assertion failed: expected 10 but got 5", dirtyFiles: [] }))
      .mockReturnValueOnce(Effect.succeed({ success: true, dirtyFiles: [] }));

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

    expect(mockRunTypeCheck).toHaveBeenCalledTimes(3);
    expect(mockRunTestSuite).toHaveBeenCalledTimes(2);
    expect(mockGenerateStructuredObject).toHaveBeenCalledTimes(2);
    expect(mockApplyPatch).toHaveBeenCalledTimes(3); 
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(dummyTx, "self-correction success - aggregate attempts: 2", undefined);
    expect(mockCreateWorktree).toHaveBeenCalledWith(dummyTx);
    expect(mockDeleteWorktree).toHaveBeenCalledWith(dummyTx);
  });

  it("should preserve original stable state and halt safely when aggregate correction threshold is exhausted during the test phase", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);

    mockRunTypeCheck.mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));
    mockRunLintCheck.mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));

    mockRunTestSuite.mockReturnValue(
      Effect.succeed({
        success: false,
        errorOutput: "Behavioral test failing continuously.",
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
      expect(err.message).toContain("exceeded the maximum threshold of 3 aggregate correction attempts during testing");
      expect(err.message).toContain("Worktree preserved at:");
    }

    expect(mockRunTypeCheck).toHaveBeenCalledTimes(4);
    expect(mockRunTestSuite).toHaveBeenCalledTimes(4);
    expect(mockGenerateStructuredObject).toHaveBeenCalledTimes(3);
    expect(mockApplyPatch).toHaveBeenCalledTimes(4); 
    expect(mockCreateWorktree).toHaveBeenCalledWith(dummyTx);
    expect(mockDeleteWorktree).not.toHaveBeenCalled();
  });

  it("should accumulate attempts across all phases and abort when cumulative corrections exceed 3", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);

    mockRunTypeCheck
      .mockReturnValueOnce(Effect.succeed({ success: false, errorOutput: "tsc broken", dirtyFiles: [] }))
      .mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));

    mockRunLintCheck
      .mockReturnValueOnce(Effect.succeed({ success: false, errorOutput: "eslint broken", dirtyFiles: [] }))
      .mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));

    mockRunTestSuite
      .mockReturnValueOnce(Effect.succeed({ success: false, errorOutput: "test broken 1", dirtyFiles: [] }))
      .mockReturnValueOnce(Effect.succeed({ success: false, errorOutput: "test broken 2", dirtyFiles: [] }));

    mockGenerateStructuredObject.mockReturnValue(
      Effect.succeed({
        summary: "Attempt corrective patch",
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
      expect(err.message).toContain("exceeded the maximum threshold of 3 aggregate correction attempts");
      expect(err.message).toContain("Worktree preserved at:");
    }

        expect(mockGenerateStructuredObject).toHaveBeenCalledTimes(3);
    expect(mockApplyPatch).toHaveBeenCalledTimes(4); 
    expect(mockCreateWorktree).toHaveBeenCalledWith(dummyTx);
    expect(mockDeleteWorktree).not.toHaveBeenCalled();
  });

  it("should successfully handle and self-heal containerized execution failures", async () => {
    mockApplyPatch.mockReturnValue(Effect.void);
    mockRunLintCheck.mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));
    mockRunTestSuite.mockReturnValue(Effect.succeed({ success: true, dirtyFiles: [] }));
    mockCreateCheckpoint.mockImplementation((tx) => Effect.succeed(tx));

    mockRunTypeCheck
      .mockReturnValueOnce(
        Effect.succeed({
          success: false,
          errorOutput: "docker: Error response from daemon: OOMKilled\nTS2322: Type 'string' is not assignable to type 'number'.",
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
        summary: "Fix string assignment under containerized runner",
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

    expect(mockRunTypeCheck).toHaveBeenCalledTimes(2);
    expect(mockApplyPatch).toHaveBeenCalledTimes(2);
    expect(mockGenerateStructuredObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("docker: Error response from daemon")
      })
    );
  });
});

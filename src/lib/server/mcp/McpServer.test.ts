import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import { McpService, McpServiceLive, McpLoggerLive } from "./McpServer.ts";
import { PatchApplicationError } from "../AiderPatcher.ts";
import * as fs from "node:fs/promises";

const { mockConnect, mockTools, passedServerInfo } = vi.hoisted(() => {
  return {
    mockConnect: vi.fn().mockResolvedValue(undefined),
    mockTools: {} as Record<string, Function>,
    passedServerInfo: { value: null as any },
  };
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  return {
    McpServer: class {
      constructor(public info: any) {
        passedServerInfo.value = info;
      }
      connect = mockConnect;
      tool(name: string, desc: string, schema: any, handler: Function) {
        mockTools[name] = handler;
      }
    }
  };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  return {
    StdioServerTransport: class {}
  };
});

const { mockSpawnOn, mockSpawnStdoutOn, mockSpawnStderrOn } = vi.hoisted(() => ({
  mockSpawnOn: vi.fn(),
  mockSpawnStdoutOn: vi.fn(),
  mockSpawnStderrOn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const actualWithDefault = actual as typeof import("node:child_process") & { default?: Record<string, unknown> };
  const spawnMock = vi.fn().mockImplementation(() => {
    return {
      stdout: {
        on: mockSpawnStdoutOn,
      },
      stderr: {
        on: mockSpawnStderrOn,
      },
      on: mockSpawnOn,
    };
  });
  return {
    ...actual,
    spawn: spawnMock,
    default: {
      ...actualWithDefault.default,
      spawn: spawnMock,
    },
  };
});

vi.mock("node:fs/promises", () => {
  return {
    readFile: vi.fn(),
  };
});

const mockInitTransaction = vi.fn();
const mockCreateCheckpoint = vi.fn();
const mockRollbackToCheckpoint = vi.fn();
const mockCommitTransaction = vi.fn();
const mockAbortTransaction = vi.fn();
const mockApplyPatch = vi.fn();
const mockListDirectories = vi.fn();
const mockCreateWorktree = vi.fn();
const mockDeleteWorktree = vi.fn();
const mockRunTypeCheck = vi.fn();
const mockRunLintCheck = vi.fn();
const mockRunTestSuite = vi.fn();

vi.mock("../WorkspaceController.ts", () => {
  return {
    makeWorkspaceController: () => ({
      initTransaction: mockInitTransaction,
      createCheckpoint: mockCreateCheckpoint,
      rollbackToCheckpoint: mockRollbackToCheckpoint,
      commitTransaction: mockCommitTransaction,
      abortTransaction: mockAbortTransaction,
      applyPatch: mockApplyPatch,
      listDirectories: mockListDirectories,
      createWorktree: mockCreateWorktree,
      deleteWorktree: mockDeleteWorktree,
      runTypeCheck: mockRunTypeCheck,
      runLintCheck: mockRunLintCheck,
      runTestSuite: mockRunTestSuite,
    }),
  };
});

describe("McpServer Unit and Tool Integration Tests", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Load/Register tools
    const initProgram = Effect.gen(function* () {
      const mcp = yield* McpService;
      yield* mcp.start();
    }).pipe(
      Effect.provide(McpServiceLive),
      Effect.provide(McpLoggerLive)
    );
    await Effect.runPromise(initProgram);
  });

  const getToolHandler = (name: string): Function => {
    const handler = mockTools[name];
    if (!handler) {
      throw new Error(`MCP tool "${name}" is not registered`);
    }
    return handler;
  };

  it("should initialize with correct metadata config", () => {
    expect(passedServerInfo.value).toEqual({
      name: "grug-code-mcp",
      version: "0.1.0"
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("should successfully trigger git_init_tx and return transaction metadata", async () => {
    const mockTx = {
      id: "mcp-test-task",
      baseBranch: "main",
      ephemeralBranch: "grug-task/mcp-test-task",
      checkpoints: []
    };
    mockInitTransaction.mockReturnValue(Effect.succeed(mockTx));

    const handler = getToolHandler("git_init_tx");
    const response = await handler({ taskId: "mcp-test-task" });
    expect(response).toEqual({
      content: [{ type: "text", text: JSON.stringify(mockTx) }]
    });
    expect(mockInitTransaction).toHaveBeenCalledWith("mcp-test-task");
  });

  it("should successfully create a Git checkpoint milestone", async () => {
    const tx = { id: "mcp-test-task", baseBranch: "main", ephemeralBranch: "grug-task/mcp-test-task", checkpoints: [] };
    const mockTxWithCheckpoint = { ...tx, checkpoints: ["hash-123"] };
    mockCreateCheckpoint.mockReturnValue(Effect.succeed(mockTxWithCheckpoint));

    const handler = getToolHandler("git_create_checkpoint");
    const response = await handler({ tx, message: "Add landing page layout" });

    expect(response).toEqual({
      content: [{ type: "text", text: JSON.stringify(mockTxWithCheckpoint) }]
    });
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(tx, "Add landing page layout");
  });

  it("should successfully rollback to a specific checkpoint", async () => {
    const tx = { id: "mcp-test-task", baseBranch: "main", ephemeralBranch: "grug-task/mcp-test-task", checkpoints: ["hash-123"] };
    const mockTxRolledBack = { ...tx, checkpoints: [] };
    mockRollbackToCheckpoint.mockReturnValue(Effect.succeed(mockTxRolledBack));

    const handler = getToolHandler("git_rollback");
    const response = await handler({ tx, commitHash: "hash-base" });

    expect(response).toEqual({
      content: [{ type: "text", text: JSON.stringify(mockTxRolledBack) }]
    });
    expect(mockRollbackToCheckpoint).toHaveBeenCalledWith(tx, "hash-base");
  });

  it("should successfully commit a transaction", async () => {
    const tx = { id: "mcp-test", baseBranch: "main", ephemeralBranch: "eb", checkpoints: [] };
    mockCommitTransaction.mockReturnValue(Effect.void);

    const handler = getToolHandler("git_commit");
    const response = await handler({ tx });

    expect(response).toEqual({
      content: [{ type: "text", text: "Transaction successfully committed and merged." }]
    });
    expect(mockCommitTransaction).toHaveBeenCalledWith(tx);
  });

  it("should successfully abort a transaction", async () => {
    const tx = { id: "mcp-test", baseBranch: "main", ephemeralBranch: "eb", checkpoints: [] };
    mockAbortTransaction.mockReturnValue(Effect.void);

    const handler = getToolHandler("git_abort");
    const response = await handler({ tx });

    expect(response).toEqual({
      content: [{ type: "text", text: "Transaction successfully aborted and workspace restored cleanly." }]
    });
    expect(mockAbortTransaction).toHaveBeenCalledWith(tx);
  });

  it("should return detailed diagnostics on apply_patch failure", async () => {
    const tx = { id: "p1", baseBranch: "main", ephemeralBranch: "eb", checkpoints: [] };
    const patchErr = new PatchApplicationError({
      message: "Block 1 failed to match.",
      path: "src/math.ts",
      failedSearchBlock: "const x = 999;",
      proposedReplacement: "const x = 42;",
      actualContextSnippet: "const x = 1;"
    });
    mockApplyPatch.mockReturnValue(Effect.fail(patchErr));

    const handler = getToolHandler("apply_patch");
    const response = await handler({ tx, patch: "diff content" });

    expect(response.isError).toBe(true);
    const parsedData = JSON.parse(response.content[0].text);
    expect(parsedData.error).toBe("Block 1 failed to match.");
    expect(parsedData.filePath).toBe("src/math.ts");
    expect(parsedData.failedSearchBlock).toBe("const x = 999;");
  });

  it("should successfully list subdirectories under workspace root", async () => {
    const dirs = ["src", "src/components"];
    mockListDirectories.mockReturnValue(Effect.succeed(dirs));

    const handler = getToolHandler("list_directories");
    const response = await handler({});

    expect(response).toEqual({
      content: [{ type: "text", text: JSON.stringify(dirs) }]
    });
    expect(mockListDirectories).toHaveBeenCalled();
  });

  it("should successfully trigger grug_create_worktree tool", async () => {
    const tx = { id: "mcp-test-task", baseBranch: "main", ephemeralBranch: "grug-task/mcp-test-task", checkpoints: [] };
    mockCreateWorktree.mockReturnValue(Effect.succeed("/mock/cache/worktrees/task-mcp-test-task"));

    const handler = getToolHandler("grug_create_worktree");
    const response = await handler({ tx });

    expect(response).toEqual({
      content: [{ type: "text", text: "/mock/cache/worktrees/task-mcp-test-task" }]
    });
    expect(mockCreateWorktree).toHaveBeenCalledWith(tx);
  });

  it("should successfully trigger grug_delete_worktree tool", async () => {
    const tx = { id: "mcp-test-task", baseBranch: "main", ephemeralBranch: "grug-task/mcp-test-task", checkpoints: [] };
    mockDeleteWorktree.mockReturnValue(Effect.void);

    const handler = getToolHandler("grug_delete_worktree");
    const response = await handler({ tx });

    expect(response).toEqual({
      content: [{ type: "text", text: "Worktree deleted successfully." }]
    });
    expect(mockDeleteWorktree).toHaveBeenCalledWith(tx);
  });

  it("should successfully trigger search_code_ripgrep tool", async () => {
    const handler = getToolHandler("search_code_ripgrep");

    // Mock spawn behavior
    mockSpawnOn.mockImplementation((event: string, cb: Function) => {
      if (event === "close") {
        setTimeout(() => cb(0), 0);
      }
      return { on: mockSpawnOn };
    });
    mockSpawnStdoutOn.mockImplementation((event: string, cb: Function) => {
      if (event === "data") {
        setTimeout(() => cb(Buffer.from("src/math.ts:1:const x = 42;")), 0);
      }
      return { on: mockSpawnStdoutOn };
    });

    const response = await handler({ pattern: "const x", glob: "*.ts" });
    expect(response).toEqual({
      content: [{ type: "text", text: "src/math.ts:1:const x = 42;" }]
    });
  });

  it("should successfully trigger ast_grep_pattern tool", async () => {
    const handler = getToolHandler("ast_grep_pattern");

    mockSpawnOn.mockImplementation((event: string, cb: Function) => {
      if (event === "close") {
        setTimeout(() => cb(0), 0);
      }
      return { on: mockSpawnOn };
    });
    mockSpawnStdoutOn.mockImplementation((event: string, cb: Function) => {
      if (event === "data") {
        setTimeout(() => cb(Buffer.from("[{\"text\": \"let a = 1\"}]")), 0);
      }
      return { on: mockSpawnStdoutOn };
    });

    const response = await handler({ pattern: "let $A = $B" });
    expect(response).toEqual({
      content: [{ type: "text", text: "[{\"text\": \"let a = 1\"}]" }]
    });
  });

  it("should successfully trigger read_file_content tool and enforce security guards", async () => {
    const handler = getToolHandler("read_file_content");

    const mockReadFile = vi.mocked(fs.readFile);
    mockReadFile.mockResolvedValue("export const hello = 'world';");

    // 1. Success case
    const responseSuccess = await handler({ filePath: "src/hello.ts" });
    expect(responseSuccess).toEqual({
      content: [{ type: "text", text: "export const hello = 'world';" }]
    });

    // 2. Traversal block case
        const responseFail = await handler({ filePath: "../../../etc/passwd" });
    expect(responseFail.isError).toBe(true);
    expect(responseFail.content[0].text).toContain("Path traversal attempt detected");
  });

  it("should trigger runTypeCheck via grug_verify_step tool call", async () => {
    const tx = { id: "mcp-test-task", baseBranch: "main", ephemeralBranch: "grug-task/mcp-test-task", checkpoints: [] };
    const mockResult = { success: true, dirtyFiles: [] };
    mockRunTypeCheck.mockReturnValue(Effect.succeed(mockResult));

    const handler = getToolHandler("grug_verify_step");
    const response = await handler({ tx, type: "typecheck" });

    expect(response).toEqual({
      content: [{ type: "text", text: JSON.stringify(mockResult) }]
    });
    expect(mockRunTypeCheck).toHaveBeenCalledWith(tx);
  });

  it("should trigger runLintCheck via grug_verify_step tool call and return fail outputs on error", async () => {
    const tx = { id: "mcp-test-task", baseBranch: "main", ephemeralBranch: "grug-task/mcp-test-task", checkpoints: [] };
    const mockResult = { success: false, errorOutput: "Eslint style failure", dirtyFiles: [] };
    mockRunLintCheck.mockReturnValue(Effect.succeed(mockResult));

    const handler = getToolHandler("grug_verify_step");
    const response = await handler({ tx, type: "lint" });

    expect(response).toEqual({
      content: [{ type: "text", text: JSON.stringify(mockResult) }]
    });
    expect(mockRunLintCheck).toHaveBeenCalledWith(tx);
  });

  it("should trigger runTestSuite via grug_verify_step tool call and capture test logs correctly", async () => {
    const tx = { id: "mcp-test-task", baseBranch: "main", ephemeralBranch: "grug-task/mcp-test-task", checkpoints: [] };
    const mockResult = { success: false, errorOutput: "Test case failed expected 1 to be 2", dirtyFiles: [] };
    mockRunTestSuite.mockReturnValue(Effect.succeed(mockResult));

    const handler = getToolHandler("grug_verify_step");
    const response = await handler({ tx, type: "test" });

    expect(response).toEqual({
      content: [{ type: "text", text: JSON.stringify(mockResult) }]
    });
    expect(mockRunTestSuite).toHaveBeenCalledWith(tx);
  });
});

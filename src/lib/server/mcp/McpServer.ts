import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Context, Effect, Layer, Logger } from "effect";
import { z } from "zod";
import { makeWorkspaceController } from "../WorkspaceController.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { serverRuntime } from "../server-runtime.ts";
import { TreeSitterParserLive } from "../TreeSitterParser.ts";
import { PatchApplicationError } from "../AiderPatcher.ts";
import { ResearchLoop, ResearchLoopLive } from "../../../features/agent/ResearchLoop.ts";
import { ProjectStructureMapper, ProjectStructureMapperLive } from "../../../features/agent/ProjectStructureMapper.ts";
import { CorrectionLoop, CorrectionLoopLive } from "../../../features/agent/CorrectionLoop.ts";
import { AiServiceLive } from "../AiService.ts";
import { SurgicalRouterLive } from "../SurgicalRouter.ts";
import { TokenEstimatorLive } from "../TokenEstimator.ts";

export interface IMcpService {
  readonly start: () => Effect.Effect<void, Error>;
}

export class McpService extends Context.Tag("McpService")<
  McpService,
  IMcpService
>() {}

export const McpLoggerLive = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ logLevel, message }) => {
    console.error(`[${logLevel.label}] [McpServer] ${String(message)}`);
  })
);

const gitTransactionZodShape = {
  id: z.string(),
  baseBranch: z.string(),
  ephemeralBranch: z.string(),
  checkpoints: z.array(z.string()),
};

export const mcpServer = new McpServer({
  name: "grug-code-mcp",
  version: "0.1.0",
});

// Register MCP tools on our top-level server singleton
mcpServer.tool(
  "git_init_tx",
  "Initialize an isolated, ephemeral Git branch for a given taskId. Verifies workspace is clean first.",
  {
    taskId: z.string().describe("The unique ID for the task transaction"),
    cwd: z.string().optional().describe("Working directory for the workspace repository")
  },
  async ({ taskId, cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const result = await serverRuntime.runPromise(
      Effect.either(controller.initTransaction(taskId))
    );
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.right) }],
    };
  }
);

mcpServer.tool(
  "grug_create_worktree",
  "Creates a background Git worktree to isolate task edits and verification.",
  {
    tx: z.object(gitTransactionZodShape).describe("The active Git transaction details"),
    cwd: z.string().optional().describe("Working directory of the workspace")
  },
  async ({ tx, cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const result = await serverRuntime.runPromise(
      Effect.either(controller.createWorktree(tx))
    );
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: result.right }],
    };
  }
);

mcpServer.tool(
  "grug_delete_worktree",
  "Deletes the background Git worktree for an active or completed task transaction.",
  {
    tx: z.object(gitTransactionZodShape).describe("The active Git transaction details"),
    cwd: z.string().optional().describe("Working directory of the workspace")
  },
  async ({ tx, cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const result = await serverRuntime.runPromise(
      Effect.either(controller.deleteWorktree(tx))
    );
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: "Worktree deleted successfully." }],
    };
  }
);

mcpServer.tool(
  "git_create_checkpoint",
  "Create a stable Git checkpoint milestone inside the active task transaction.",
  {
    tx: z.object(gitTransactionZodShape).describe("The active Git transaction details"),
    message: z.string().describe("A descriptive label for this checkpoint"),
    cwd: z.string().optional().describe("Working directory for the workspace repository")
  },
  async ({ tx, message, cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const result = await serverRuntime.runPromise(
      Effect.either(controller.createCheckpoint(tx, message))
    );
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.right) }],
    };
  }
);

mcpServer.tool(
  "git_rollback",
  "Rollback the working tree hard to a previously created checkpoint hash.",
  {
    tx: z.object(gitTransactionZodShape).describe("The active Git transaction details"),
    commitHash: z.string().describe("The checkpoint Git commit hash to roll back to"),
    cwd: z.string().optional().describe("Working directory for the workspace repository")
  },
  async ({ tx, commitHash, cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const result = await serverRuntime.runPromise(
      Effect.either(controller.rollbackToCheckpoint(tx, commitHash))
    );
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.right) }],
    };
  }
);

mcpServer.tool(
  "git_commit",
  "Successfully commit and merge the ephemeral branch back into baseBranch, closing the transaction.",
  {
    tx: z.object(gitTransactionZodShape).describe("The active Git transaction details"),
    cwd: z.string().optional().describe("Working directory for the workspace repository")
  },
  async ({ tx, cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const result = await serverRuntime.runPromise(
      Effect.either(controller.commitTransaction(tx))
    );
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: "Transaction successfully committed and merged." }],
    };
  }
);

mcpServer.tool(
  "git_abort",
  "Abort the ephemeral branch transaction, discarding all changes and restoring base branch cleanly.",
  {
    tx: z.object(gitTransactionZodShape).describe("The active Git transaction details"),
    cwd: z.string().optional().describe("Working directory for the workspace repository")
  },
  async ({ tx, cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const result = await serverRuntime.runPromise(
      Effect.either(controller.abortTransaction(tx))
    );
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: "Transaction successfully aborted and workspace restored cleanly." }],
    };
  }
);

mcpServer.tool(
  "apply_patch",
  "Apply an Aider-style multi-file SEARCH/REPLACE block patch to the workspace.",
  {
    tx: z.object(gitTransactionZodShape).describe("The active Git transaction details"),
    patch: z.string().describe("The Aider patch SEARCH/REPLACE JSON string"),
    cwd: z.string().optional().describe("Working directory for the workspace repository")
  },
  async ({ tx, patch, cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const effect = controller.applyPatch(tx, patch).pipe(
      Effect.provide(TreeSitterParserLive)
    );
    const result = await serverRuntime.runPromise(Effect.either(effect));
    if (result._tag === "Left") {
      const error = result.left;
      if (error instanceof PatchApplicationError) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: error.message,
              filePath: error.path,
              failedSearchBlock: error.failedSearchBlock,
              proposedReplacement: error.proposedReplacement,
              actualContextSnippet: error.actualContextSnippet,
                })
              }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: "Patch applied successfully." }],
        };
      }
    );

mcpServer.tool(
  "list_directories",
  "Recursively list subdirectories in the workspace, ignoring standard dependency folders.",
  {
    cwd: z.string().optional().describe("Working directory for the workspace repository")
  },
  async ({ cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const result = await serverRuntime.runPromise(
      Effect.either(controller.listDirectories())
    );
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.right) }],
    };
  }
);

mcpServer.tool(
  "search_code_ripgrep",
  "Safely spawns ripgrep (rg) process pipelines to run multi-threaded regex searches across files.",
  {
    pattern: z.string().describe("The regular expression pattern to search for"),
    glob: z.string().optional().describe("Optional glob pattern filter, e.g. '*.ts'"),
    cwd: z.string().optional().describe("Working directory to search in")
  },
  async ({ pattern, glob, cwd }) => {
    const root = path.resolve(cwd || process.cwd());
    const args = ["--line-number", "--column", "--color=never", "--smart-case", "--heading"];
    if (glob) {
      args.push("-g", glob);
    }
    args.push(pattern);

    return new Promise((resolve) => {
      const child = spawn("rg", args, { cwd: root });
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) {
          stdout += chunk.toString("utf-8");
        } else {
          stdout += String(chunk);
        }
      });
      child.stderr?.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) {
          stderr += chunk.toString("utf-8");
        } else {
          stderr += String(chunk);
        }
      });

      child.on("close", (code) => {
        if (code === 0 || code === 1) {
          resolve({
            content: [{ type: "text", text: stdout || "No matches found." }],
          });
        } else {
          resolve({
            content: [{ type: "text", text: `Ripgrep execution failed or command not found. Stderr: ${stderr}` }],
            isError: true,
          });
        }
      });

      child.on("error", (err: unknown) => {
        const hasCode = err !== null && typeof err === "object" && "code" in err;
        const hasMessage = err !== null && typeof err === "object" && "message" in err;
        const code = hasCode ? String((err as Record<string, unknown>)["code"]) : "";
        const errMsg = hasMessage ? String((err as Record<string, unknown>)["message"]) : String(err);

        if (code === "ENOENT") {
          resolve({
            content: [{ type: "text", text: "Ripgrep command 'rg' not found on the local system. Please install ripgrep to enable regex searching." }],
            isError: true,
          });
        } else {
          resolve({
            content: [{ type: "text", text: `Failed to spawn ripgrep: ${errMsg}` }],
            isError: true,
          });
        }
      });
    });
  }
);

mcpServer.tool(
  "ast_grep_pattern",
  "Safely spawns ast-grep to locate structural code patterns within the workspace.",
  {
    pattern: z.string().describe("The structural pattern query to search for, e.g. 'let $X = $Y'"),
    cwd: z.string().optional().describe("Working directory to search in")
  },
  async ({ pattern, cwd }) => {
    const root = path.resolve(cwd || process.cwd());
    const args = ["run", "--pattern", pattern, "--json=flat"];

    return new Promise((resolve) => {
      const child = spawn("ast-grep", args, { cwd: root });
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) {
          stdout += chunk.toString("utf-8");
        } else {
          stdout += String(chunk);
        }
      });
      child.stderr?.on("data", (chunk: unknown) => {
        if (Buffer.isBuffer(chunk)) {
          stderr += chunk.toString("utf-8");
        } else {
          stderr += String(chunk);
        }
      });

      child.on("close", (code) => {
        if (code === 0 || code === 1) {
          resolve({
            content: [{ type: "text", text: stdout || "No structural matches found." }],
          });
        } else {
          resolve({
            content: [{ type: "text", text: `ast-grep execution failed. Stderr: ${stderr}` }],
            isError: true,
          });
        }
      });

      child.on("error", (err: unknown) => {
        const hasCode = err !== null && typeof err === "object" && "code" in err;
        const hasMessage = err !== null && typeof err === "object" && "message" in err;
        const code = hasCode ? String((err as Record<string, unknown>)["code"]) : "";
        const errMsg = hasMessage ? String((err as Record<string, unknown>)["message"]) : String(err);

        if (code === "ENOENT") {
          resolve({
            content: [{ type: "text", text: "ast-grep command not found on the local system. Please install ast-grep to enable structural search." }],
            isError: true,
          });
        } else {
          resolve({
            content: [{ type: "text", text: `Failed to spawn ast-grep: ${errMsg}` }],
            isError: true,
          });
        }
      });
    });
  }
);

mcpServer.tool(
  "read_file_content",
  "Securely read the raw text content of a workspace file, enforcing directory traversal protections.",
  {
    filePath: z.string().describe("The relative path of the file to read"),
    cwd: z.string().optional().describe("Working directory of the workspace")
  },
  async ({ filePath, cwd }) => {
    const root = path.resolve(cwd || process.cwd());
    const resolvedPath = path.resolve(root, filePath);

    // Security check: Guard against directory traversal
    if (!resolvedPath.startsWith(root)) {
      return {
        content: [{ type: "text", text: "Error: Access denied. Path traversal attempt detected." }],
        isError: true,
      };
    }

        try {
      const content = await fs.readFile(resolvedPath, "utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: "text", text: `Error: Failed to read file content: ${message}` }],
        isError: true,
      };
    }
  }
);

mcpServer.tool(
  "grug_skeletal_research",
  "Executes the Stage 1 skeletal pre-planning research loop to scan candidate signatures and build task checklists.",
  {
    userPrompt: z.string().describe("User prompt describing the desired code change or feature implementation"),
    cwd: z.string().optional().describe("Root directory path of the active project workspace"),
    provider: z.enum(["gemini", "openai", "deepseek"]).optional().default("openai").describe("LLM provider to execute the planning loop"),
    mode: z.enum(["standard", "discussion"]).optional().default("standard").describe("Select standard autopilot planning or interactive advisory discussion mode"),
    history: z.array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string()
      })
    ).optional().default([]).describe("Conversation Turn History array used in advisory discussion mode")
  },
  async ({ userPrompt, cwd, provider, mode, history }) => {
    const effect = Effect.gen(function* () {
      const mapper = yield* ProjectStructureMapper;
      const loop = yield* ResearchLoop;
      const projectStructure = yield* mapper.mapProject({ cwd });
      return yield* loop.run({
        userPrompt,
        projectStructure,
        cwd,
        provider,
        mode,
        history,
      });
    }).pipe(
      Effect.provide(ResearchLoopLive),
      Effect.provide(ProjectStructureMapperLive),
      Effect.provide(AiServiceLive),
      Effect.provide(TreeSitterParserLive),
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    const result = await serverRuntime.runPromise(Effect.either(effect));
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    } 
    return {
      content: [{ type: "text", text: JSON.stringify(result.right) }],
    };
  }
);

mcpServer.tool(
  "execute_step",
  "Executes a planned implementation step, applying edits and verifying them with self-correction.",
  {
    tx: z.object(gitTransactionZodShape).describe("The active Git transaction details"),
    targetFiles: z.array(z.string()).describe("The list of files targeted by this step"),
    instructions: z.string().describe("The developer instructions or descriptions for this step"),
    cwd: z.string().optional().describe("Working directory for the workspace repository"),
    currentTaskId: z.string().optional().describe("Optional task ID to update the step status"),
    tasks: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        targetFiles: z.array(z.string()),
        status: z.enum(["pending", "running", "completed", "failed"]),
        developerNotes: z.string().nullable()
      })
    ).optional().describe("The complete list of tasks in the active plan")
  },
  async ({ tx, targetFiles, instructions, cwd, currentTaskId, tasks }) => {
    const mappedTasks = tasks?.map((t) => ({
      ...t,
      developerNotes: t.developerNotes ?? null,
    }));
    const effect = Effect.flatMap(CorrectionLoop, (loop) =>
      loop.runStep({
        tx,
        targetFiles,
        instructions,
        cwd,
        tasks: mappedTasks,
        currentTaskId
      })
    ).pipe(
      Effect.provide(CorrectionLoopLive),
      Effect.provide(AiServiceLive),
      Effect.provide(TreeSitterParserLive)
    );

    const result = await serverRuntime.runPromise(Effect.either(effect));
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.right) }],
    };
  }
);

mcpServer.tool(
  "git_get_status",
  "Read the active transaction state from disk.",
  {
    cwd: z.string().optional().describe("Working directory of the workspace")
  },
  async ({ cwd }) => {
    const controller = makeWorkspaceController(cwd);
    const result = await serverRuntime.runPromise(
      Effect.either(controller.readTransactionState())
    );
    if (result._tag === "Left") {
      return {
        content: [{ type: "text", text: `Error: ${result.left.message}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.right) }],
    };
  }
);

export const McpServiceLive = Layer.sync(
  McpService,
  () => {
    const start = () =>
      Effect.gen(function* () {
        const isUdsMcp = 
          (typeof Bun !== "undefined" && Bun.argv && Bun.argv.includes("--transport=uds")) || 
          (typeof process !== "undefined" && process.argv && process.argv.includes("--transport=uds"));

        if (isUdsMcp) {
          yield* Effect.logInfo("[McpService] Spawning in UDS transport mode. Stdio connector bypassed.");
          return;
        }

        yield* Effect.logInfo("[McpService] Initializing MCP Server with Stdio transport...");
        const transport = new StdioServerTransport();
        
        yield* Effect.tryPromise({
          try: () => mcpServer.connect(transport),
          catch: (e) => new Error(`Failed to establish stdio connection for MCP server: ${String(e)}`),
        });

        yield* Effect.logInfo("[McpService] MCP Server stdio connection completed successfully.");
      });

    return { start };
  }
);

/**
 * Utility to globally redirect standard stdout (console.log) to stderr.
 * This prevents accidental library or third-party log statements from polluting
 * stdout, which would otherwise corrupt the stdio-based MCP JSON-RPC protocol stream.
 */
export const redirectConsoleLogToStderr = () => {
  /* eslint-disable-next-line no-console */
  console.log = (...args: unknown[]) => {
    console.error("[Redirected stdout]:", ...args);
  };
};

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
    console.error(`[${logLevel.label}] [McpServer] ${message}`);
  })
);

const gitTransactionZodShape = {
  id: z.string(),
  baseBranch: z.string(),
  ephemeralBranch: z.string(),
  checkpoints: z.array(z.string()),
};

export const McpServiceLive = Layer.sync(
  McpService,
  () => {
    const server = new McpServer({
      name: "grug-code-mcp",
      version: "0.1.0",
    });

    // 1. git_init_tx
    server.tool(
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

    // 2. git_create_checkpoint
    server.tool(
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

    // 3. git_rollback
    server.tool(
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

    // 4. git_commit
    server.tool(
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

    // 5. git_abort
    server.tool(
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

    // 6. apply_patch
    server.tool(
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

        // 7. list_directories
    server.tool(
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

    // 8. search_code_ripgrep
    server.tool(
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

          child.stdout?.on("data", (data) => {
            stdout += data.toString();
          });
          child.stderr?.on("data", (data) => {
            stderr += data.toString();
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

          child.on("error", (err: any) => {
            if (err.code === "ENOENT") {
              resolve({
                content: [{ type: "text", text: "Ripgrep command 'rg' not found on the local system. Please install ripgrep to enable regex searching." }],
                isError: true,
              });
            } else {
              resolve({
                content: [{ type: "text", text: `Failed to spawn ripgrep: ${err.message}` }],
                isError: true,
              });
            }
          });
        });
      }
    );

    // 9. ast_grep_pattern
    server.tool(
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

          child.stdout?.on("data", (data) => {
            stdout += data.toString();
          });
          child.stderr?.on("data", (data) => {
            stderr += data.toString();
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

          child.on("error", (err: any) => {
            if (err.code === "ENOENT") {
              resolve({
                content: [{ type: "text", text: "ast-grep command not found on the local system. Please install ast-grep to enable structural search." }],
                isError: true,
              });
            } else {
              resolve({
                content: [{ type: "text", text: `Failed to spawn ast-grep: ${err.message}` }],
                isError: true,
              });
            }
          });
        });
      }
    );

    // 10. read_file_content
    server.tool(
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
        } catch (e: any) {
          return {
            content: [{ type: "text", text: `Error: Failed to read file content: ${e.message}` }],
            isError: true,
          };
        }
      }
    );

    const start = () =>
      Effect.gen(function* () {
        yield* Effect.logInfo("[McpService] Initializing MCP Server with Stdio transport...");
        const transport = new StdioServerTransport();
        
        yield* Effect.tryPromise({
          try: () => server.connect(transport),
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
  console.log = (...args: unknown[]) => {
    console.error("[Redirected stdout]:", ...args);
  };
};

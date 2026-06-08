import * as p from "@clack/prompts";
import { Effect, ManagedRuntime, Layer } from "effect";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { ProjectStructureMapper, ProjectStructureMapperLive } from "./features/ProjectStructureMapper.ts";
import { ResearchLoop, ResearchLoopLive } from "./features/ResearchLoop.ts";
import { AiServiceLive } from "./lib/AiService.ts";
import { TreeSitterParserLive } from "./lib/TreeSitterParser.ts";
import { SurgicalRouterLive } from "./features/SurgicalRouter.ts";
import { TokenEstimatorLive } from "./lib/TokenEstimator.ts";
import type { PlanTask } from "./lib/ai-schemas.ts";

const CliLive = SurgicalRouterLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectStructureMapperLive,
      ResearchLoopLive,
      AiServiceLive,
      TreeSitterParserLive,
      TokenEstimatorLive
    )
  )
);

const cliRuntime = ManagedRuntime.make(CliLive);

const checkCancel = (value: unknown) => {
  if (p.isCancel(value)) {
    p.cancel("Grug operation cancelled.");
    process.exit(0);
  }
};

interface McpToolResult {
  readonly content: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
  }>;
}

interface PlanningResult {
  readonly status: "discussion" | "resolved";
  readonly discussionText?: string;
  readonly suggestedOptions?: readonly string[];
  readonly target_files?: readonly string[];
  readonly plan?: readonly PlanTask[];
}

export const runCli = () =>
  Effect.gen(function* () {
    const args = process.argv.slice(2);
    if (args[0] === "logs" || args[0] === "tail") {
      const follow = args.includes("--follow") || args.includes("-f") || args[0] === "tail";
      const taskIdArg = args.find(arg => arg !== "logs" && arg !== "tail" && arg !== "--follow" && arg !== "-f");

      if (!taskIdArg) {
        console.error("Error: Missing active taskId parameter.");
        process.exit(1);
      }

      const port = process.env.DAEMON_PORT ? parseInt(process.env.DAEMON_PORT, 10) : 3010;

      const logTailingEffect = Effect.gen(function* () {
        const sseResponse = yield* Effect.tryPromise({
          try: () => fetch(`http://localhost:${port}/api/mcp/sse`),
          catch: (err) => new Error(`Daemon unreachable: ${String(err)}`)
        });

        if (!sseResponse.ok) {
          return yield* Effect.fail(new Error("SSE connection failed"));
        }

        const reader = sseResponse.body?.getReader();
        if (!reader) return yield* Effect.fail(new Error("Failed to get readable stream reader"));

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (err) => new Error(`Stream read failure: ${String(err)}`)
          });

          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              const dataStr = trimmed.slice(6);
              if (dataStr === "heartbeat") continue;
              try {
                const parsed = JSON.parse(dataStr) as Record<string, unknown>;
                if (
                  parsed &&
                  parsed.method === "notifications/progress" &&
                  parsed.params &&
                  typeof parsed.params === "object"
                ) {
                  const params = parsed.params as Record<string, unknown>;
                  if (params.progressToken === taskIdArg && typeof params.message === "string") {
                    process.stdout.write(params.message);
                  }
                }
              } catch {
                // Ignore malformed or unrelated frames
              }
            }
          }

          if (!follow) {
            break;
          }
        }
      });

      yield* logTailingEffect.pipe(
        Effect.catchAll((err) => Effect.sync(() => {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }))
      );

      process.exit(0);
    }

    p.intro("🥟 Grug Code CLI Companion");

    let promptArg = process.argv.slice(2).join(" ").trim();
    if (!promptArg) {
      const promptInput = yield* Effect.promise(() =>
        p.text({
          message: "What feature or fix do you want Grug to pre-plan?",
          placeholder: "e.g. Add payment gateway",
          validate(value: string | undefined) {
            if (!value || !value.trim()) return "Task prompt is required!";
          },
        })
      );
      checkCancel(promptInput);
      promptArg = promptInput as string;
    }

    const port = process.env.DAEMON_PORT ? parseInt(process.env.DAEMON_PORT, 10) : 3010;
    let isDaemonOnline = false;

    const checkDaemon = Effect.promise(() =>
      fetch(`http://localhost:${port}/api/health`)
    ).pipe(
      Effect.map((res) => res.ok),
      Effect.catchAll(() => Effect.succeed(false))
    );
    isDaemonOnline = yield* checkDaemon;

    const callDaemonTool = (toolName: string, args: Record<string, unknown>) =>
      Effect.promise(async () => {
        const sseResponse = await fetch(`http://localhost:${port}/api/mcp/sse`);
        if (!sseResponse.ok) throw new Error("SSE connection failed");

        const reader = sseResponse.body?.getReader();
        if (!reader) throw new Error("Failed to get reader");

        const readResult = await reader.read();
        const value: unknown = readResult.value;
        const rawText = value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
        const sessionIdMatch = /sessionId=([a-zA-Z0-9\\-]+)/.exec(rawText);
        const sessionId = sessionIdMatch?.[1];
        if (!sessionId) {
          await reader.cancel();
          throw new Error("Missing sessionId");
        }

        const initRequest = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "grug-cli-client", version: "0.1.0" }
          }
        };
        await fetch(`http://localhost:${port}/api/mcp/messages?sessionId=${sessionId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(initRequest)
        });

        const callRequest = {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args
          }
        };
        const callRes = await fetch(`http://localhost:${port}/api/mcp/messages?sessionId=${sessionId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(callRequest)
        });
        const callResult = (await callRes.json()) as {
          readonly result?: McpToolResult;
          readonly error?: {
            readonly message?: string;
          };
        };
        await reader.cancel();

        if (callResult.error) {
          throw new Error(callResult.error.message || "Tool execution failed");
        }
        if (!callResult.result) {
          throw new Error("Tool execution returned no result");
        }
        return callResult.result;
      });

    const s = p.spinner();
    s.start("Grug scanning workspace directories...");

    let projectStructure = "";
    if (isDaemonOnline) {
      s.message("Grug scanning workspace directories (via Daemon)...");
      try {
        const callResult = yield* callDaemonTool("grug_map_project", {});
        projectStructure = callResult.content[0]?.text || "";
      } catch (err) {
        s.stop();
        p.note(`Failed to scan directories via daemon: ${String(err)}. Falling back to local execution.`, "⚠️ Warning");
        isDaemonOnline = false;
        s.start("Grug scanning workspace directories...");
      }
    }

    if (!isDaemonOnline) {
      const mapper = yield* ProjectStructureMapper;
      projectStructure = yield* mapper.mapProject({});
    }

    s.message("Grug pre-planning implementation loop...");

    let turnHistory: Array<{ role: "user" | "assistant"; text: string }> = [];
    let currentPrompt = promptArg;
    let resolved = false;

    while (!resolved) {
      const mode = turnHistory.length > 0 ? "discussion" : "standard";
      let result: PlanningResult | null = null;

      if (isDaemonOnline) {
        s.message("Grug pre-planning implementation loop (via Daemon)...");
        try {
          const callResult = yield* callDaemonTool("grug_skeletal_research", {
            userPrompt: currentPrompt,
            projectStructure,
            provider: "openai",
            mode,
            history: turnHistory,
          });
          const text = callResult.content[0]?.text;
          if (!text) {
            throw new Error("Empty response from daemon skeletal research tool");
          }
          result = JSON.parse(text) as PlanningResult;
        } catch (err) {
          s.stop();
          p.note(`Failed to execute planning via daemon: ${String(err)}. Falling back to local execution.`, "⚠️ Warning");
          isDaemonOnline = false;
          s.start("Grug pre-planning implementation loop...");
        }
      }

      if (!isDaemonOnline || result === null) {
        const loop = yield* ResearchLoop;
        result = yield* loop.run({
          userPrompt: currentPrompt,
          projectStructure,
          provider: "openai",
          mode,
          history: turnHistory,
        });
      }

      s.stop("Grug done pre-planning.");

      if (result.status === "discussion") {
        p.note(result.discussionText || "", "Grug Advisory Discussion");

        const suggestedOptions = result.suggestedOptions || [];
        const options = suggestedOptions.map((o: string) => ({
          value: o,
          label: o,
        }));

        options.push({ value: "custom-reply", label: "Write a custom reply..." });
        options.push({ value: "cancel", label: "Cancel planning" });

        const choice = yield* Effect.promise(() =>
          p.select({
            message: "Select a response:",
            options,
          })
        );
        checkCancel(choice);

        if (choice === "cancel") {
          p.cancel("Grug planning aborted.");
          process.exit(0);
        }

        let nextText = choice as string;
        if (choice === "custom-reply") {
          const customInput = yield* Effect.promise(() =>
            p.text({
              message: "Type your custom reply:",
              validate(value: string | undefined) {
                if (!value || !value.trim()) return "Reply cannot be empty!";
              },
            })
          );
          checkCancel(customInput);
          nextText = customInput as string;
        }

        turnHistory = [
          ...turnHistory,
          { role: "user", text: currentPrompt },
          { role: "assistant", text: result.discussionText || "" },
        ];
        currentPrompt = nextText;
        s.start("Grug recalculating options...");
      } else {
        resolved = true;

        const files = result.target_files || [];
        const plan = result.plan || [];

        p.note(
          plan.map((t: PlanTask, i: number) => `${i + 1}. ${t.description} (Targets: ${t.targetFiles.join(", ") || "none"})`).join("\n"),
          "Proposed Implementation Steps"
        );

        const selectedFiles = yield* Effect.promise(() =>
          p.multiselect({
            message: "Confirm target files to proceed with:",
            options: files.map((f: string) => ({ value: f, label: f, hint: "target" })),
            required: false,
          })
        );
        checkCancel(selectedFiles);

        const approve = yield* Effect.promise(() =>
          p.confirm({
            message: "Approve and start transaction?",
          })
        );
        checkCancel(approve);

        if (approve) {
          if (isDaemonOnline) {
            s.start("Grug initializing active transaction on Daemon...");
            const taskId = `cli-task-${crypto.randomUUID().slice(0, 8)}`;
            
            let txResultText = "";
            try {
              const callResult = yield* callDaemonTool("git_init_tx", {
                taskId,
                tasks: plan,
              });
              txResultText = callResult.content[0]?.text || "";
            } catch (err) {
              s.stop();
              p.cancel(`Failed to initialize transaction on daemon: ${String(err)}`);
              process.exit(1);
            }
            s.stop("Transaction initialized.");

            const tx = JSON.parse(txResultText) as { id: string; baseBranch: string; ephemeralBranch: string; checkpoints: string[] };

            // Read the secure token from local session context to bypass loopback auth checks
            const sessionPath = path.resolve(process.cwd(), ".grug-session.json");
            let token = "";
            try {
              if (fsSync.existsSync(sessionPath)) {
                const fileContent = fsSync.readFileSync(sessionPath, "utf-8");
                const sessionData = JSON.parse(fileContent) as { readonly token?: string };
                if (sessionData && typeof sessionData === "object" && typeof sessionData.token === "string") {
                  token = sessionData.token;
                }
              }
            } catch {}

            s.start("Grug backgrounding task execution on Daemon...");
            const response = yield* Effect.promise(() =>
              fetch(`http://localhost:${port}/api/workspace/execute-step`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Grug-Token": token,
                },
                body: JSON.stringify({
                  tx,
                  targetFiles: selectedFiles,
                  instructions: currentPrompt,
                  tasks: plan,
                })
              })
            );

            s.stop("Task successfully backgrounded.");

            if (response.ok) {
              const bgData = yield* Effect.promise(() => response.json() as Promise<{ worktreePath: string; ephemeralBranch: string }>);
              p.note(
                `Worktree Path: ${bgData.worktreePath}\nEphemeral Branch: ${bgData.ephemeralBranch}\n\nTo tail the live execution logs, run:\nbun run grug-cli-core/src/cli.ts logs --follow ${tx.id}`,
                "🚀 Background Task Spawned Successfully"
              );
              p.outro("🎉 Grug Code background task detached cleanly! Shell released.");
              process.exit(0);
            } else {
              p.cancel(`Daemon rejected background task: ${response.statusText}`);
              process.exit(1);
            }
          } else {
            p.outro("🎉 Grug Code pre-planning approved successfully! (Local execution mode)");
          }
        } else {
          p.cancel("Planning rejected. Workspace unchanged.");
        }
      }
    }
  });

if (import.meta.main) {
  cliRuntime.runPromise(runCli()).catch((err) => {
    p.cancel(`Catastrophic error: ${String(err)}`);
    process.exit(1);
  });
}

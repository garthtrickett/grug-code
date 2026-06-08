import * as p from "@clack/prompts";
import { Effect, ManagedRuntime, Layer } from "effect";
import { ProjectStructureMapper, ProjectStructureMapperLive } from "./features/ProjectStructureMapper.ts";
import { ResearchLoop, ResearchLoopLive } from "./features/ResearchLoop.ts";
import { AiServiceLive } from "./lib/AiService.ts";
import { TreeSitterParserLive } from "./lib/TreeSitterParser.ts";
import { SurgicalRouterLive } from "./features/SurgicalRouter.ts";
import { TokenEstimatorLive } from "./lib/TokenEstimator.ts";

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

export const runCli = () =>
  Effect.gen(function* () {
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

    try {
      const healthCheck = await fetch(`http://localhost:${port}/api/health`);
      if (healthCheck.ok) {
        isDaemonOnline = true;
      }
    } catch {
      // Offline fallback
    }

    const callDaemonTool = (toolName: string, args: Record<string, any>) =>
      Effect.promise(async () => {
        const sseResponse = await fetch(`http://localhost:${port}/api/mcp/sse`);
        if (!sseResponse.ok) throw new Error("SSE connection failed");

        const reader = sseResponse.body?.getReader();
        if (!reader) throw new Error("Failed to get reader");

        const { value } = await reader.read();
        const rawText = new TextDecoder().decode(value);
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
        const callResult = await callRes.json() as any;
        await reader.cancel();

        if (callResult.error) {
          throw new Error(callResult.error.message || "Tool execution failed");
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
        projectStructure = callResult.content[0].text;
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
      let result: any;

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
          result = JSON.parse(callResult.content[0].text);
        } catch (err) {
          s.stop();
          p.note(`Failed to execute planning via daemon: ${String(err)}. Falling back to local execution.`, "⚠️ Warning");
          isDaemonOnline = false;
          s.start("Grug pre-planning implementation loop...");
        }
      }

      if (!isDaemonOnline) {
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

        const options = (result.suggestedOptions || []).map((o) => ({
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
          plan.map((t, i) => `${i + 1}. ${t.description} (Targets: ${t.targetFiles.join(", ") || "none"})`).join("\n"),
          "Proposed Implementation Steps"
        );

        const selectedFiles = yield* Effect.promise(() =>
          p.multiselect({
            message: "Confirm target files to proceed with:",
            options: files.map((f) => ({ value: f, label: f, hint: "target" })),
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
          p.outro("🎉 Grug Code pre-planning approved successfully!");
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

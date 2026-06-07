import * as p from "@clack/prompts";
import { Effect, ManagedRuntime, Layer } from "effect";
import { ProjectStructureMapper, ProjectStructureMapperLive } from "./features/ProjectStructureMapper.ts";
import { ResearchLoop, ResearchLoopLive } from "./features/ResearchLoop.ts";
import { AiServiceLive } from "./lib/AiService.ts";
import { TreeSitterParserLive } from "./lib/TreeSitterParser.ts";
import { SurgicalRouterLive } from "./features/SurgicalRouter.ts";
import { TokenEstimatorLive } from "./lib/TokenEstimator.ts";

const CliLive = Layer.mergeAll(
  ProjectStructureMapperLive,
  ResearchLoopLive,
  AiServiceLive,
  TreeSitterParserLive,
  SurgicalRouterLive,
  TokenEstimatorLive
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
          validate(value) {
            if (!value.trim()) return "Task prompt is required!";
          },
        })
      );
      checkCancel(promptInput);
      promptArg = promptInput as string;
    }

    const s = p.spinner();
    s.start("Grug scanning workspace directories...");

    const mapper = yield* ProjectStructureMapper;
    const projectStructure = yield* mapper.mapProject({});

    s.message("Grug pre-planning implementation loop...");

    const loop = yield* ResearchLoop;
    let turnHistory: Array<{ role: "user" | "assistant"; text: string }> = [];
    let currentPrompt = promptArg;
    let resolved = false;

    while (!resolved) {
      const mode = turnHistory.length > 0 ? "discussion" : "standard";
      const result = yield* loop.run({
        userPrompt: currentPrompt,
        projectStructure,
        provider: "openai",
        mode,
        history: turnHistory,
      });

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
              validate(value) {
                if (!value.trim()) return "Reply cannot be empty!";
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

if (import.meta.main && process.env.NODE_ENV !== "test") {
  cliRuntime.runPromise(runCli()).catch((err) => {
    p.cancel(`Catastrophic error: ${String(err)}`);
    process.exit(1);
  });
}
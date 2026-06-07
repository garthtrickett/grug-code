import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { runCli } from "../src/cli.ts";
import { ProjectStructureMapper } from "../src/features/ProjectStructureMapper.ts";
import { ResearchLoop } from "../src/features/ResearchLoop.ts";
import { AiService } from "../src/lib/AiService.ts";
import { TreeSitterParserLive } from "../src/lib/TreeSitterParser.ts";
import { SurgicalRouterLive } from "../src/features/SurgicalRouter.ts";
import { TokenEstimatorLive } from "../src/lib/TokenEstimator.ts";
import * as p from "@clack/prompts";

vi.mock("@clack/prompts", () => {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    text: vi.fn().mockResolvedValue("test-user-prompt"),
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn(),
    multiselect: vi.fn().mockResolvedValue(["src/main.ts"]),
    spinner: vi.fn().mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    }),
    isCancel: vi.fn().mockReturnValue(false),
    cancel: vi.fn(),
    note: vi.fn(),
  };
});

describe("Interactive CLI Prompts Test Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should orchestrate prompt menu, display proposed checklist, and handle approval cleanly", async () => {
    const mockMapper = Layer.succeed(
      ProjectStructureMapper,
      ProjectStructureMapper.of({
        mapProject: () => Effect.succeed("[\"src/main.ts\"]")
      })
    );

    const mockLoop = Layer.succeed(
      ResearchLoop,
      ResearchLoop.of({
        run: () => Effect.succeed({
          status: "resolved",
          target_files: ["src/main.ts"],
          plan: [{
            id: "step-1",
            description: "Mock main.ts step",
            targetFiles: ["src/main.ts"],
            status: "pending"
          }]
        })
      })
    );

    const mockAi = Layer.succeed(
      AiService,
      AiService.of({
        generateStructuredObject: vi.fn(),
        streamText: vi.fn(),
      })
    );

    const testRuntime = Layer.mergeAll(
      mockMapper,
      mockLoop,
      mockAi,
      TreeSitterParserLive,
      SurgicalRouterLive,
      TokenEstimatorLive
    );

    const program = runCli().pipe(Effect.provide(testRuntime));
    await Effect.runPromise(program);

    expect(p.intro).toHaveBeenCalled();
    expect(p.text).toHaveBeenCalled();
    expect(p.multiselect).toHaveBeenCalled();
    expect(p.confirm).toHaveBeenCalled();
    expect(p.outro).toHaveBeenCalledWith("🎉 Grug Code pre-planning approved successfully!");
  });
});
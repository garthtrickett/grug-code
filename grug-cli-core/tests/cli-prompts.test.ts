import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { runCli } from "../src/cli.ts";
import { ProjectStructureMapper, ProjectStructureMapperLive } from "../src/features/ProjectStructureMapper.ts";
import { ResearchLoop, ResearchLoopLive } from "../src/features/ResearchLoop.ts";
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
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should fall back to local execution cleanly if daemon is offline", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Daemon unreachable")) as any;

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
          status: "resolved" as const,
          target_files: ["src/main.ts"],
          plan: [{
            id: "step-1",
            description: "Mock main.ts step",
            targetFiles: ["src/main.ts"],
            status: "pending" as const,
            developerNotes: null
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

    const testRuntime = SurgicalRouterLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          mockMapper,
          mockLoop,
          mockAi,
          TreeSitterParserLive,
          TokenEstimatorLive
        )
      )
    );

    const program = runCli().pipe(Effect.provide(testRuntime));
    await Effect.runPromise(program);

    expect(p.intro).toHaveBeenCalled();
    expect(p.text).toHaveBeenCalled();
    expect(p.multiselect).toHaveBeenCalled();
    expect(p.confirm).toHaveBeenCalled();
    expect(p.outro).toHaveBeenCalledWith("🎉 Grug Code pre-planning approved successfully!");
  });

  it("should query the online daemon and run plan checks over network successfully", async () => {
    const mockMapperResult = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "[\"src/main.ts\"]" }]
      }
    };

    const mockResearchResult = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "resolved",
            target_files: ["src/main.ts"],
            plan: [{
              id: "step-1",
              description: "Mock main.ts step",
              targetFiles: ["src/main.ts"],
              status: "pending",
              developerNotes: null
            }]
          })
        }]
      }
    };

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/health")) {
        return Promise.resolve({ ok: true, status: 200 });
      }
      if (url.includes("/api/mcp/sse")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: () => Promise.resolve({
                value: new TextEncoder().encode("event: endpoint\ndata: /api/mcp/messages?sessionId=mock-id-123\n\n"),
                done: false
              }),
              cancel: () => Promise.resolve()
            })
          }
        });
      }
      if (url.includes("/api/mcp/messages")) {
        if (url.includes("sessionId=mock-id-123")) {
          const options = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]?.[1] as any;
          if (options && options.body) {
            const bodyObj = JSON.parse(options.body);
            if (bodyObj.method === "initialize") {
              return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({ jsonrpc: "2.0", result: { protocolVersion: "2024-11-05" } })
              });
            }
            if (bodyObj.method === "tools/call") {
              if (bodyObj.params.name === "grug_map_project") {
                return Promise.resolve({
                  ok: true,
                  status: 200,
                  json: async () => mockMapperResult
                });
              }
              if (bodyObj.params.name === "grug_skeletal_research") {
                return Promise.resolve({
                  ok: true,
                  status: 200,
                  json: async () => mockResearchResult
                });
              }
            }
          }
        }
      }
      return Promise.resolve({ ok: false, status: 400 });
    });

    global.fetch = fetchSpy as any;

    const mockMapper = Layer.succeed(
      ProjectStructureMapper,
      ProjectStructureMapper.of({
        mapProject: vi.fn(),
      })
    );

    const mockLoop = Layer.succeed(
      ResearchLoop,
      ResearchLoop.of({
        run: vi.fn(),
      })
    );

    const mockAi = Layer.succeed(
      AiService,
      AiService.of({
        generateStructuredObject: vi.fn(),
        streamText: vi.fn(),
      })
    );

    const testRuntime = SurgicalRouterLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          mockMapper,
          mockLoop,
          mockAi,
          TreeSitterParserLive,
          TokenEstimatorLive
        )
      )
    );

    const program = runCli().pipe(Effect.provide(testRuntime));
    await Effect.runPromise(program);

    expect(fetchSpy).toHaveBeenCalled();
    expect(p.intro).toHaveBeenCalled();
    expect(p.multiselect).toHaveBeenCalled();
    expect(p.confirm).toHaveBeenCalled();
    expect(p.outro).toHaveBeenCalledWith("🎉 Grug Code pre-planning approved successfully!");
  });
});

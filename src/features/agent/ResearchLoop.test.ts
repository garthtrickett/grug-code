import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import * as fs from "node:fs/promises";
import { ResearchLoop, ResearchLoopLive } from "./ResearchLoop";
import { AiService, AIInferenceError } from "../../lib/server/AiService";
import { TreeSitterParserLive } from "../../lib/server/TreeSitterParser";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    stat: vi.fn(),
    readFile: vi.fn(),
  };
});

describe("ResearchLoop - Stage 1 Skeletal Research Loop Service", () => {
  let callCount = 0;
  let capturedProviders: any[] = [];

  const mockAiService = (responses: any[]) =>
    Layer.succeed(
      AiService,
      AiService.of({
        generateStructuredObject: (options: any) =>
          Effect.sync(() => {
            capturedProviders.push(options.provider);
            const res = responses[callCount];
            if (res) {
              callCount++;
              return { response: res };
            }
            throw new Error("No response mocked for current call index");
          }),
        streamText: () =>
          Effect.fail(new AIInferenceError({ message: "Stream not mocked" })),
      })
    );

  beforeEach(() => {
    callCount = 0;
    capturedProviders = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should complete successfully in exactly 2 turns when model goes from exploring to resolved", async () => {
    const mockCodeContent = `
      export function processPayment(amount: number): boolean {
        const value = amount * 1.1;
        console.log("doing logic step", value);
        return true;
      }
    `;

    vi.mocked(fs.stat).mockImplementation(() => {
      return Promise.resolve({ isDirectory: () => false } as any);
    });

    vi.mocked(fs.readFile).mockImplementation((filePath: any) => {
      if (typeof filePath === "string" && filePath.endsWith("payment.ts")) {
        return Promise.resolve(mockCodeContent);
      }
      return Promise.reject(new Error("File not found"));
    });

    const loopResponses = [
      {
        status: "exploring",
        reason: "Need payment signature details to verify types",
        request_skeletons_for: ["src/services/payment.ts"],
      },
      {
        status: "resolved",
        target_files: ["src/services/payment.ts"],
        plan: [
          {
            id: "step-1",
            description: "Modify processPayment method signature",
            targetFiles: ["src/services/payment.ts"],
            status: "pending",
          },
        ],
      },
    ];

    const aiLayer = mockAiService(loopResponses);
    const program = Effect.flatMap(ResearchLoop, (loop) =>
      loop.run({
        userPrompt: "Adjust processing values",
        projectStructure: JSON.stringify(["src/services/payment.ts"]),
        provider: "openai",
      })
    ).pipe(
      Effect.provide(ResearchLoopLive),
      Effect.provide(aiLayer),
      Effect.provide(TreeSitterParserLive)
    );

    const result = await Effect.runPromise(program);

    expect(result.status).toBe("resolved");
    expect(result.target_files).toEqual(["src/services/payment.ts"]);
    expect(result.plan?.length).toBe(1);
    expect(result.plan?.[0]?.id).toBe("step-1");
    expect(callCount).toBe(2);
    expect(capturedProviders).toEqual(["openai", "openai"]);

    expect(fs.stat).toHaveBeenCalled();
    expect(fs.readFile).toHaveBeenCalled();
  });

  it("should transition directly to discussion status when mode is discussion", async () => {
    const loopResponses = [
      {
        status: "discussion",
        discussionText: "Grug wants to discuss Option A.",
        suggestedOptions: ["Option A"],
      },
    ];

    const aiLayer = mockAiService(loopResponses);
    const program = Effect.flatMap(ResearchLoop, (loop) =>
      loop.run({
        userPrompt: "Discuss payments",
        projectStructure: JSON.stringify([]),
        provider: "openai",
        mode: "discussion",
      })
    ).pipe(
      Effect.provide(ResearchLoopLive),
      Effect.provide(aiLayer),
      Effect.provide(TreeSitterParserLive)
    );

    const result = await Effect.runPromise(program);

    expect(result.status).toBe("discussion");
    expect(result.discussionText).toBe("Grug wants to discuss Option A.");
    expect(result.suggestedOptions).toEqual(["Option A"]);
    expect(callCount).toBe(1);
    expect(capturedProviders).toEqual(["openai"]);
  });

  it("should reject and abort with LoopThresholdExceeded when status remains exploring for 4 turns", async () => {
    vi.mocked(fs.stat).mockImplementation(() => {
      return Promise.resolve({ isDirectory: () => false } as any);
    });

    vi.mocked(fs.readFile).mockImplementation(() => {
      return Promise.resolve("export const dummy = 1;");
    });

    // Provide 5 mock structures ensuring it keeps exploring
    const loopResponses = Array(5).fill({
      status: "exploring",
      reason: "Still looking for dependency details...",
      request_skeletons_for: ["src/services/dummy.ts"],
    });

    const aiLayer = mockAiService(loopResponses);
    const program = Effect.flatMap(ResearchLoop, (loop) =>
      loop.run({
        userPrompt: "Find dependency definition structures",
        projectStructure: JSON.stringify(["src/services/dummy.ts"]),
        provider: "openai",
      })
    ).pipe(
      Effect.provide(ResearchLoopLive),
      Effect.provide(aiLayer),
      Effect.provide(TreeSitterParserLive)
    );

    const result = await Effect.runPromise(Effect.either(program));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const error: any = result.left;
      expect(error._tag).toBe("LoopThresholdExceeded");
      expect(error.message).toContain("safety threshold of 4 turns");
    }
  });
});

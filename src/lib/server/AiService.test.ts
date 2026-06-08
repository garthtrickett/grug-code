import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect } from "effect";
import { AiService, AiServiceLive } from "./AiService.ts";
import { z } from "zod";

const mockGenerateObject = vi.fn();
const mockStreamText = vi.fn();
const mockGoogleModel = vi.fn().mockImplementation(() => "mocked-google-model");
const mockOpenaiModel = vi.fn().mockImplementation(() => "mocked-openai-model");

vi.mock("ai", () => ({
  generateObject: (...args: any[]) => mockGenerateObject(...args),
  streamText: (...args: any[]) => mockStreamText(...args),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => mockGoogleModel,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => mockOpenaiModel,
}));

describe("AiService Layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should successfully generate and validate a structured object", async () => {
    const dummySchema = z.object({
      success: z.boolean(),
    });

    mockGenerateObject.mockResolvedValue({
      object: { success: true },
    });

    const program = Effect.flatMap(AiService, (ai) =>
      ai.generateStructuredObject({
        prompt: "Say yes",
        schema: dummySchema,
      })
    ).pipe(Effect.provide(AiServiceLive));

    const result = await Effect.runPromise(program);
    expect(result).toEqual({ success: true });
    expect(mockGoogleModel).toHaveBeenCalledWith("gemini-1.5-flash");
    expect(mockGenerateObject).toHaveBeenCalled();
  });

  it("should successfully generate a structured object using OpenAI when requested", async () => {
    const dummySchema = z.object({
      success: z.boolean(),
    });

    mockGenerateObject.mockResolvedValue({
      object: { success: true },
    });

    const program = Effect.flatMap(AiService, (ai) =>
      ai.generateStructuredObject({
        provider: "openai",
        prompt: "Say yes",
        schema: dummySchema,
      })
    ).pipe(Effect.provide(AiServiceLive));

    const result = await Effect.runPromise(program);
    expect(result).toEqual({ success: true });
    expect(mockOpenaiModel).toHaveBeenCalledWith("gpt-4o-mini");
    expect(mockGenerateObject).toHaveBeenCalled();
  });

  it("should successfully generate a structured object using Deepseek when requested", async () => {
    const dummySchema = z.object({
      success: z.boolean(),
    });

    mockGenerateObject.mockResolvedValue({
      object: { success: true },
    });

    const program = Effect.flatMap(AiService, (ai) =>
      ai.generateStructuredObject({
        provider: "deepseek",
        prompt: "Say yes",
        schema: dummySchema,
      })
    ).pipe(Effect.provide(AiServiceLive));

    const result = await Effect.runPromise(program);
    expect(result).toEqual({ success: true });
    expect(mockOpenaiModel).toHaveBeenCalledWith("deepseek-chat");
    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "json",
      })
    );
  });

  it("should translate failed generateObject calls into AIInferenceError", async () => {
    const dummySchema = z.object({
      success: z.boolean(),
    });

    mockGenerateObject.mockRejectedValue(new Error("API Key Invalid (401)"));

    const program = Effect.flatMap(AiService, (ai) =>
      ai.generateStructuredObject({
        prompt: "Fail me",
        schema: dummySchema,
      })
    ).pipe(Effect.provide(AiServiceLive));

    const result = await Effect.runPromise(Effect.either(program));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const err: any = result.left;
      expect(err._tag).toBe("AIInferenceError");
      expect(err.message).toContain("API Key Invalid");
    }
  });

  it("should successfully initiate a streaming text result", async () => {
    mockStreamText.mockReturnValue({
      textStream: "streaming-chunks",
    });

    const program = Effect.flatMap(AiService, (ai) =>
      ai.streamText({
        prompt: "Stream this",
      })
    ).pipe(Effect.provide(AiServiceLive));

    const result = await Effect.runPromise(program);
    expect(result).toBeDefined();
    expect((result as any).textStream).toBe("streaming-chunks");
    expect(mockGoogleModel).toHaveBeenCalledWith("gemini-1.5-flash");
    expect(mockStreamText).toHaveBeenCalled();
  });

  it("should successfully initiate an OpenAI streaming text result", async () => {
    mockStreamText.mockReturnValue({
      textStream: "openai-streaming-chunks",
    });

    const program = Effect.flatMap(AiService, (ai) =>
      ai.streamText({
        provider: "openai",
        prompt: "Stream this",
      })
    ).pipe(Effect.provide(AiServiceLive));

    const result = await Effect.runPromise(program);
    expect(result).toBeDefined();
    expect((result as any).textStream).toBe("openai-streaming-chunks");
    expect(mockOpenaiModel).toHaveBeenCalledWith("gpt-4o-mini");
    expect(mockStreamText).toHaveBeenCalled();
  });

  it("should successfully initiate a Deepseek streaming text result", async () => {
    mockStreamText.mockReturnValue({
      textStream: "deepseek-streaming-chunks",
    });

    const program = Effect.flatMap(AiService, (ai) =>
      ai.streamText({
        provider: "deepseek",
        prompt: "Stream this",
      })
    ).pipe(Effect.provide(AiServiceLive));

    const result = await Effect.runPromise(program);
    expect(result).toBeDefined();
    expect((result as any).textStream).toBe("deepseek-streaming-chunks");
    expect(mockOpenaiModel).toHaveBeenCalledWith("deepseek-chat");
    expect(mockStreamText).toHaveBeenCalled();
  });
});

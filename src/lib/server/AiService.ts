import { Context, Effect, Layer } from "effect";
import { generateObject, streamText, type StreamTextResult } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "./Config.ts";
import { z } from "zod";
import { Data } from "effect";
import * as fs from "node:fs";

export class AIInferenceError extends Data.TaggedError("AIInferenceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface IAiService {
  readonly generateStructuredObject: <T>(options: {
    readonly provider?: "gemini" | "openai" | "deepseek";
    readonly modelName?: string;
    readonly system?: string;
    readonly prompt: string;
    readonly schema: z.Schema<T>;
  }) => Effect.Effect<T, AIInferenceError>;

  readonly streamText: (options: {
    readonly provider?: "gemini" | "openai" | "deepseek";
    readonly modelName?: string;
    readonly system?: string;
    readonly prompt: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) => Effect.Effect<StreamTextResult<any, any>, AIInferenceError>;
}

export class AiService extends Context.Tag("AiService")<
  AiService,
  IAiService
>() {}

export const AiServiceLive = Layer.sync(
  AiService,
  () => {
    const google = createGoogleGenerativeAI({ apiKey: config.gemini.apiKey });
    const openai = createOpenAI({ apiKey: config.openai.apiKey });
    const deepseek = createOpenAI({
      apiKey: config.deepseek.apiKey || config.openai.apiKey,
      baseURL: "https://api.deepseek.com",
    });

    const defaultGeminiModel = "gemini-flash-latest";
    const defaultOpenaiModel = "openai/gpt-4o-mini";
    const defaultDeepseekModel = "deepseek-v4-flash";

    return {
      generateStructuredObject: <T>({
        provider = "gemini",
        modelName,
        system,
        prompt,
        schema,
      }: {
        readonly provider?: "gemini" | "openai" | "deepseek";
        readonly modelName?: string;
        readonly system?: string;
        readonly prompt: string;
        readonly schema: z.Schema<T>;
      }) =>
        Effect.gen(function* () {
          // Cross-process testing override for offline headless E2E testing
          if (process.env.VITEST !== "true" && (fs.existsSync(".grug-mock-ai") || process.env.MOCK_AI_RESPONSE === "true")) {
            yield* Effect.logInfo(`[AiService] Intercepting prompt with mock testing response: "${prompt.substring(0, 40)}..."`);
            if (prompt.includes("compilation failed")) {
              return {
                summary: "Fix compile error",
                files: [
                  {
                    file_path: "main.ts",
                    code_diff: "<<<<<<< SEARCH\nexport const x: number = 'broken';\n=======\nexport const x: number = 10;\n>>>>>>> REPLACE"
                  }
                ]
              } as unknown as T;
            }
            if (prompt.includes("test failures")) {
              return {
                summary: "Fix test error",
                files: [
                  {
                    file_path: "main.ts",
                    code_diff: "<<<<<<< SEARCH\nexport const x: number = 10;\n=======\nexport const x: number = 42;\n>>>>>>> REPLACE"
                  }
                ]
              } as unknown as T;
            }
            return { files: [] } as unknown as T;
          }

                    const resolvedModel = modelName ?? (provider === "openai" ? defaultOpenaiModel : provider === "deepseek" ? defaultDeepseekModel : defaultGeminiModel);
          const modelInstance = provider === "openai" ? openai(resolvedModel) : provider === "deepseek" ? deepseek(resolvedModel) : google(resolvedModel);

          const result = yield* Effect.tryPromise({
            try: () =>
              generateObject({
                model: modelInstance,
                schema,
                system,
                prompt,
              }),
            catch: (cause) =>
              new AIInferenceError({
                message: `Failed to generate structured object: ${String(cause)}`,
                cause,
              }),
          });
          return result.object;
        }),

            streamText: ({
        provider = "gemini",
        modelName,
        system,
        prompt,
      }: {
        readonly provider?: "gemini" | "openai" | "deepseek";
        readonly modelName?: string;
        readonly system?: string;
        readonly prompt: string;
      }) =>
        Effect.try({
          try: () => {
            const resolvedModel = modelName ?? (provider === "openai" ? defaultOpenaiModel : provider === "deepseek" ? defaultDeepseekModel : defaultGeminiModel);
            const modelInstance = provider === "openai" ? openai(resolvedModel) : provider === "deepseek" ? deepseek(resolvedModel) : google(resolvedModel);
            return streamText({
              model: modelInstance,
              system,
              prompt,
            });
          },
          catch: (cause) =>
            new AIInferenceError({
              message: `Failed to stream text: ${String(cause)}`,
              cause,
            }),
        }),
    };
  }
);

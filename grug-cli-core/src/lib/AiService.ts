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
          if (process.env.VITEST !== "true" && (fs.existsSync(".grug-mock-ai") || process.env.MOCK_AI_RESPONSE === "true")) {
            yield* Effect.logInfo(`[AiService] Intercepting prompt with mock testing response: "${prompt.substring(0, 40)}..."`);
            if (prompt.includes("LIGHTWEIGHT FLAT REPOSITORY MAP")) {
              const isDiscussionMode = system && system.includes("\"discussion\" mode is enabled");
              if (isDiscussionMode && !prompt.includes("Proceed with plan")) {
                return {
                  status: "discussion",
                  discussionText: "Grug has analyzed your codebase. Let's discuss Option A vs Option B.",
                  suggestedOptions: ["Proceed with plan", "Compare details"]
                } as unknown as T;
              }
              return {
                status: "resolved",
                target_files: ["initial.txt", "main.ts", "worker.ts"],
                plan: [
                  {
                    id: "step-mock-analysis",
                    description: "Analyze codebase targets",
                    targetFiles: ["initial.txt"],
                    status: "completed"
                  },
                  {
                    id: "step-mock-patch",
                    description: "Apply custom patch",
                    targetFiles: ["initial.txt"],
                    status: "pending"
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
                ...(provider === "deepseek" ? { mode: "json" } : {}),
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
import { Context, Effect, Layer } from "effect";
import { generateObject, streamText, type StreamTextResult } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
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
    readonly modelName?: string;
    readonly system?: string;
    readonly prompt: string;
    readonly schema: z.Schema<T>;
  }) => Effect.Effect<T, AIInferenceError>;

  readonly streamText: (options: {
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
    const apiKey = config.gemini.apiKey;
    const google = createGoogleGenerativeAI({ apiKey });
    const defaultModel = "gemini-2.5-flash";

    return {
      generateStructuredObject: <T>({
        modelName = defaultModel,
        system,
        prompt,
        schema,
      }: {
        readonly modelName?: string;
        readonly system?: string;
        readonly prompt: string;
        readonly schema: z.Schema<T>;
      }) =>
        Effect.gen(function* () {
          // Cross-process testing override for offline headless E2E testing
          if (fs.existsSync(".grug-mock-ai") || process.env.MOCK_AI_RESPONSE === "true") {
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

          const result = yield* Effect.tryPromise({
            try: () =>
              generateObject({
                model: google(modelName),
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
        modelName = defaultModel,
        system,
        prompt,
      }: {
        readonly modelName?: string;
        readonly system?: string;
        readonly prompt: string;
      }) =>
        Effect.try({
          try: () =>
            streamText({
              model: google(modelName),
              system,
              prompt,
            }),
          catch: (cause) =>
            new AIInferenceError({
              message: `Failed to stream text: ${String(cause)}`,
              cause,
            }),
        }),
    };
  }
);

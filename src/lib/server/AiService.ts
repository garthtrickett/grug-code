import { Context, Effect, Layer } from "effect";
import { generateObject, streamText, type StreamTextResult } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { config } from "./Config.ts";
import { z } from "zod";
import { Data } from "effect";

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

import { Data, Effect, Schema } from "effect";
import { createJWT, validateJWT } from "oslo/jwt";
import { TimeSpan } from "oslo";
import { config } from "./Config";
import { AuthError } from "../shared/auth";
import type { PublicUser } from "../shared/schemas";
import { PublicUserSchema } from "../shared/schemas";
import { serverRuntime } from "./server-runtime";

export class JwtGenerationError extends Data.TaggedError("JwtGenerationError")<{
  readonly cause: unknown;
}> {}

export class JwtValidationError extends Data.TaggedError("JwtValidationError")<{
  readonly cause: unknown;
}> {}

const secretKey = new TextEncoder().encode(config.jwt.secret);

interface SafePromiseLike<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>;
}

const makeServerThenable = <A, E, R extends never>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> & SafePromiseLike<A> => {
  const thenable = effect as unknown as Effect.Effect<A, E, R> & SafePromiseLike<A>;
  Object.defineProperty(thenable, "then", {
    value: function <TResult1 = A, TResult2 = never>(
      onFulfilled?: ((value: A) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): PromiseLike<TResult1 | TResult2> {
      return serverRuntime.runPromise(effect).then(onFulfilled, onRejected);
    },
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return thenable;
};

export const generateToken = (user: PublicUser, options?: { expiresIn?: TimeSpan }) => {
  const effect = Effect.gen(function* () {
    const payload = yield* Schema.encode(PublicUserSchema)(user).pipe(
      Effect.mapError((cause) => new JwtGenerationError({ cause })),
    );

    const expiration = options?.expiresIn ?? new TimeSpan(30, "d");

    return yield* Effect.tryPromise({
      try: () =>
        createJWT(
          "HS256",
          secretKey,
          payload as Record<string, unknown>,
          {
            subject: user.id,
            expiresIn: expiration,
            includeIssuedTimestamp: true,
          },
        ),
      catch: (cause) => new JwtGenerationError({ cause }),
    });
  });

  return makeServerThenable(effect);
};

export const validateToken = (token: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`[JwtService] Validating token: "${token?.substring(0, 15)}..."`);
    const jwt = yield* Effect.tryPromise({ 
      try: () => validateJWT("HS256", secretKey, token),
      catch: (cause) => new JwtValidationError({ cause }),
    });

    if (!jwt.payload) {
      return yield* Effect.fail(
        new JwtValidationError({
          cause: "Invalid token payload: missing payload object",
        }),
      );
    }

    const user = yield* Schema.decodeUnknown(PublicUserSchema)(jwt.payload);
    yield* Effect.logInfo(`[JwtService] Token successfully validated for user: ${user.email}`);

    return user;
  }).pipe(
    Effect.catchTags({
      JwtValidationError: (error) =>
        Effect.fail(
          new AuthError({
            _tag: "Unauthorized",
            message: `Invalid or expired token: ${String(error.cause)}`,
          }),
        ),
      ParseError: (cause) =>
        Effect.logError(
          "Failed to parse user from JWT payload",
          cause,
        ).pipe(
          Effect.andThen(
            Effect.fail(
              new AuthError({
                _tag: "Unauthorized",
                message: "Token payload is invalid or corrupted.",
              }),
            ),
          ),
        ),
    }),
  );

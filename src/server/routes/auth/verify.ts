import { Elysia, t } from "elysia";
import { Effect } from "effect";
import { userContext } from "../../context"; 
import { effectPlugin } from "../../middleware/effect-plugin";
import { handleAuthResult } from "./utils";
import { db } from "../../../db/client";
import { AuthDatabaseError } from "../../../features/auth/Errors";

export const verifyRoute = new Elysia()
  .use(userContext) 
  .use(effectPlugin)
  .post(
    "/verifyEmail",
    async ({ body, set, runEffect }: { body: { token: string }; set: { status?: number | string }; runEffect: <A, E>(effect: Effect.Effect<A, E, unknown>) => Promise<A> }) => {
      const verifyEffect = Effect.gen(function* () {
        const { token } = body;

        yield* Effect.logInfo(`[Verify] Verifying token ${token}`);
        const user = yield* Effect.tryPromise({
          try: () =>
            db
              .selectFrom("user")
              .selectAll()
              .executeTakeFirst(),
          catch: (cause) => new AuthDatabaseError({ cause }),
        });

        return { user, success: true };
      });

      const result = await runEffect(Effect.either(verifyEffect));
      return handleAuthResult(result, set);
    },
    {
      body: t.Object({
        token: t.String(),
      }),
    },
  );

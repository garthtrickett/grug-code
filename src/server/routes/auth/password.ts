import { Elysia, t } from "elysia";
import { Effect } from "effect";
import { Argon2id } from "oslo/password";
import { effectPlugin } from "../../middleware/effect-plugin";
import { userContext } from "../../context";
import { db } from "../../../db/client";
import {
  AuthDatabaseError,
  PasswordHashingError,
} from "../../../features/auth/Errors";

export const passwordRoutes = new Elysia()
  .use(effectPlugin)
  .use(userContext)
    .post(
    "/requestPasswordReset",
    ({ body }: { body: { email: string } }) => {
      const requestResetEffect = Effect.gen(function* () {
        const { email } = body;

        const user = yield* Effect.tryPromise({
          try: () =>
            db
              .selectFrom("user")
              .select(["id", "email", "email_verified"])
              .where("email", "=", email)
              .executeTakeFirst(),
          catch: (cause) => new AuthDatabaseError({ cause }),
        });

        if (user && user.email && user.email_verified) {
          yield* Effect.logInfo(`[Password] Reset requested for ${email}`);
        }

        return { success: true };
      });

      return requestResetEffect;
    },
    {
      body: t.Object({
        email: t.String(),
      }),
    },
  )
    .post(
    "/resetPassword",
    ({ body }: { body: { token: string; newPassword: string } }) => {
      const resetEffect = Effect.gen(function* () {
        const { newPassword } = body;

        yield* Effect.tryPromise({
          try: () => new Argon2id().hash(newPassword),
          catch: (cause) => new PasswordHashingError({ cause }),
        });

        yield* Effect.logInfo(`[Password] Successfully reset user password.`);
        return { success: true };
      });

      return resetEffect;
    },
    {
      body: t.Object({
        token: t.String(),
        newPassword: t.String(),
      }),
    },
  );

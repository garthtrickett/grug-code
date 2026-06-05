import { Elysia, t } from "elysia";
import { Effect } from "effect";
import { Argon2id } from "oslo/password";
import { db } from "../../../db/client";
import { effectPlugin } from "../../middleware/effect-plugin";
import { handleAuthResult } from "./utils";
import { ROLE_PERMISSIONS } from "../../../lib/shared/permissions";
import {
  AuthDatabaseError,
  EmailInUseError,
  PasswordHashingError,
} from "../../../features/auth/Errors";
import type { UserId } from "../../../types";

export const signupRoute = new Elysia()
  .use(effectPlugin)
  .post(
    "/signup",
    async ({ body, set, runEffect }) => {
      const signupEffect = Effect.gen(function* () {
        const { email, password } = body;

        yield* Effect.logInfo(`[Signup] Validating unique credentials for ${email}`);
        const existingUser = yield* Effect.tryPromise({
          try: () =>
            db
              .selectFrom("user")
              .select("id")
              .where("email", "=", email)
              .executeTakeFirst(),
          catch: (cause) => new AuthDatabaseError({ cause }),
        });

        if (existingUser) {
          yield* Effect.logError(`[Signup] Aborting - ${email} already occupied.`);
          return yield* Effect.fail(new EmailInUseError({ email, cause: "Email already exists" }));
        }

        const hashedPassword = yield* Effect.tryPromise({
          try: () => new Argon2id().hash(password),
          catch: (cause) => new PasswordHashingError({ cause }),
        });

        const userId = crypto.randomUUID() as UserId;
        const permissions = [...ROLE_PERMISSIONS.SUBSCRIBER];

        yield* Effect.logInfo(`[Signup] Provisioning default subscriber record for ${email}`);
        yield* Effect.tryPromise({
          try: () =>
            db
              .insertInto("user")
              .values({
                id: userId,
                email,
                password_hash: hashedPassword,
                permissions,
                email_verified: true, // Consumer model bypasses validation gating
                created_at: new Date(),
                updated_at: new Date(),
              })
              .execute(),
          catch: (cause) => new AuthDatabaseError({ cause }),
        });

        yield* Effect.logInfo(`[Signup] Subscriber account created: ID is ${userId}`);
        return { id: userId, email, error: undefined };
      });

      const result = await runEffect(Effect.either(signupEffect));
      return handleAuthResult(result, set);
    },
    {
      body: t.Object({
        email: t.String(),
        password: t.String(),
      }),
    },
  );

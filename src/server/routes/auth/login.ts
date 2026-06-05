import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { Argon2id } from 'oslo/password';
import { TimeSpan } from 'oslo';
import { generateToken } from '../../../lib/server/JwtService';
import { effectPlugin } from '../../middleware/effect-plugin';
import { handleAuthResult } from './utils';
import { db } from '../../../db/client';
import {
  AuthDatabaseError,
  InvalidCredentialsError,
  PasswordHashingError,
} from '../../../features/auth/Errors';
import type { PublicUser } from '../../../lib/shared/schemas';

export const deriveRole = (permissions: readonly string[]): string => {
  if (permissions.includes("platform:manage")) return "PLATFORM_OWNER";
  if (permissions.includes("deck:manage")) return "CURATOR";
  return "SUBSCRIBER";
};

export const loginRoute = new Elysia()
  .use(effectPlugin)
  .post(
    '/login',
    async ({ body, set, runEffect }) => {
      const loginEffect = Effect.gen(function* () {
        const { email, password } = body;
        const argon = new Argon2id();

        yield* Effect.logInfo(`[Login] Checking platform admin directory for ${email}`);
        const admin = yield* Effect.tryPromise({
          try: () => db
            .selectFrom('platform_admin')
            .selectAll()
            .where('email', '=', email)
            .executeTakeFirst(),
          catch: (cause) => new AuthDatabaseError({ cause }),
        });

        if (admin) {
          const isValid = yield* Effect.tryPromise({
            try: () => argon.verify(admin.password_hash, password),
            catch: (cause) => new PasswordHashingError({ cause })
          });

          if (isValid) {
            yield* Effect.logInfo(`[Login] Admin match. Handshaking platform admin session.`);
            const adminUser: PublicUser = {
              id: admin.id,
              email: admin.email,
              email_verified: true,
              permissions: ["platform:manage"],
              created_at: admin.created_at,
              avatar_url: null,
              is_guest: false,
              display_name: "Platform Admin",
              phone: null,
              skills: []
            };

            const token = yield* generateToken(adminUser);

            return { 
              user: adminUser,
              token,
              role: "PLATFORM_OWNER",
            };
          }
        }

        yield* Effect.logInfo(`[Login] Admin mismatch. Checking user directory for ${email}`);
        const userRow = yield* Effect.tryPromise({
          try: () => db
            .selectFrom('user')
            .selectAll()
            .where('email', '=', email)
            .executeTakeFirst(),
          catch: (cause) => new AuthDatabaseError({ cause }),
        });

        if (!userRow) {
          yield* Effect.logError(`[Login] User with email ${email} not found.`);
          return yield* Effect.fail(new InvalidCredentialsError());
        }

        if (!userRow.password_hash) {
          return yield* Effect.fail(new InvalidCredentialsError());
        }

        const isValidUserPassword = yield* Effect.tryPromise({
          try: () => argon.verify(userRow.password_hash, password),
          catch: (cause) => new PasswordHashingError({ cause })
        });

        if (!isValidUserPassword) {
          yield* Effect.logError(`[Login] Credentials match failure for ${email}`);
          return yield* Effect.fail(new InvalidCredentialsError());
        }

        yield* Effect.logInfo(`[Login] Credentials approved. Launching subscriber session.`);
        const publicUser: PublicUser = {
          id: userRow.id,
          email: userRow.email,
          permissions: userRow.permissions || [],
          avatar_url: userRow.avatar_url,
          email_verified: userRow.email_verified,
          created_at: userRow.created_at,
          phone: userRow.phone,
          display_name: userRow.display_name,
          is_guest: false,
          skills: []
        };

        const derivedRole = deriveRole(publicUser.permissions);
        const token = yield* generateToken(publicUser, { expiresIn: new TimeSpan(30, "d") });

        return { 
          user: publicUser, 
          token,
          role: derivedRole,
        };
      });

      const result = await runEffect(Effect.either(loginEffect));
      return handleAuthResult(result, set);
    },
    {
      body: t.Object({
        email: t.String(),
        password: t.String(),
      }),
    },
  );

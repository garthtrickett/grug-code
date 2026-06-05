import { Effect } from "effect";
import { type Transaction } from "kysely";
import { generateId } from "../../lib/server/utils";
import { config } from "../../lib/server/Config";
import type { Database } from "../../types";

const getTenantUrl = (subdomain: string) => {
  if (config.app.nodeEnv === "development") {
    return `http://${subdomain}.localhost:3000`;
  }
  return `https://${subdomain}.${config.app.rootDomain}`;
};

export const sendVerificationEmail = (email: string, token: string, subdomain: string) =>
  Effect.gen(function* () {
    const link = getTenantUrl(subdomain) + "/verify-email/" + token;
    yield* Effect.logWarning(
      "[EmailService] VERIFICATION LINK for " + email + ": " + link,
    );
  });

export const sendPasswordResetEmail = (email: string, token: string, subdomain: string) =>
  Effect.gen(function* () {
    const link = getTenantUrl(subdomain) + "/reset-password/" + token;
    yield* Effect.logWarning(
      "[EmailService] RESET LINK for " + email + ": " + link,
    );
  });

export const createVerificationToken = (
  trx: Transaction<Database>,
  userId: string,
  email: string,
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(
      "[AuthService] Creating verification token for " + email,
    );
    const verificationToken = yield* generateId(40);
    // Standard user verification token insertion mapping
    return verificationToken;
  });

export const createPasswordResetToken = (
  trx: Transaction<Database>,
  userId: string,
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(
      "[AuthService] Creating password reset token for " + userId,
    );
    const tokenId = yield* generateId(40);
    return tokenId;
  });

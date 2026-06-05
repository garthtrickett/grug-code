import { Either } from "effect";
import {
  EmailInUseError,
  SubdomainInUseError,
  EmailNotVerifiedError,
  InvalidCredentialsError,
  TokenInvalidError,
  UserProvisioningError,
} from "../../../features/auth/Errors";

export const handleAuthResult = <A>(
  result: Either.Either<A, unknown>,
  set: { status?: number | string },
) => {
  if (Either.isRight(result)) {
    return result.right;
  }

  const error = result.left;

  if (error instanceof InvalidCredentialsError) {
    set.status = 401;
    return { error: "Invalid credentials", token: undefined, user: undefined };
  }
  if (error instanceof EmailNotVerifiedError) {
    set.status = 401;
    return { error: "Email not verified", token: undefined, user: undefined };
  }
  if (error instanceof EmailInUseError) {
    set.status = 409;
    return { error: "Email already in use", id: undefined };
  }
  if (error instanceof SubdomainInUseError) {
    set.status = 409;
    return { error: "Workspace URL (subdomain) is already taken" };
  }
  if (error instanceof TokenInvalidError) {
    set.status = 400;
    return { error: "Invalid or expired token" };
  }
  if (error instanceof UserProvisioningError) {
    console.error("[Auth] Provisioning Failed:", error.cause);
    set.status = 500;
    return { error: "Failed to provision account resources" };
  }

  console.error("[Auth] Internal Error:", error);
  set.status = 500;
  return { error: "Internal Server Error" };
};

import { Data } from "effect";
import { ParseError } from "effect/ParseResult";

export class AuthDatabaseError extends Data.TaggedError("AuthDatabaseError")<{
  readonly cause: unknown;
}> {}

export class PasswordHashingError extends Data.TaggedError(
  "PasswordHashingError",
)<{
  readonly cause: unknown;
}> {}

export class EmailInUseError extends Data.TaggedError("EmailInUseError")<{
  readonly email: string;
  readonly cause: unknown;
}> {}

export class SubdomainInUseError extends Data.TaggedError("SubdomainInUseError")<{
  readonly subdomain: string;
}> {}

export class InvalidCredentialsError extends Data.TaggedError(
  "InvalidCredentialsError",
) {}

export class EmailNotVerifiedError extends Data.TaggedError(
  "EmailNotVerifiedError",
) {}

export class TokenCreationError extends Data.TaggedError("TokenCreationError")<{
  readonly cause: unknown;
}> {}

export class TokenInvalidError extends Data.TaggedError("TokenInvalidError")<{
  cause?: unknown;
}> {}

export class EmailSendError extends Data.TaggedError("EmailSendError")<{
  readonly cause: unknown;
}> {}

export class AuthValidationError extends Data.TaggedError(
  "AuthValidationError",
)<{
  readonly cause: ParseError;
}> {}

export class EmailAlreadyExistsError extends Data.TaggedError(
  "EmailAlreadyExistsError",
) {}

export class UserProvisioningError extends Data.TaggedError(
  "UserProvisioningError",
)<{
  readonly cause: unknown;
}> {}

export class TenantNotFoundError extends Data.TaggedError("TenantNotFoundError")<{
  readonly subdomain: string;
}> {}

export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly userId: string;
  readonly tenantId: string;
}> {}

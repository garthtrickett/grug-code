import { Context, Schema } from "effect";
import { RpcMiddleware } from "@effect/rpc";
import type { PublicUser } from "./schemas";

export class Auth extends Context.Tag("Auth")<
  Auth,
  { readonly user: PublicUser | null }
>() {}

export class AuthError extends Schema.Class<AuthError>("AuthError")({
  _tag: Schema.Literal(
    "Unauthorized",
    "Forbidden",
    "BadRequest",
    "EmailAlreadyExistsError",
    "InternalServerError",
  ),
  message: Schema.String,
}) {}

export class AuthMiddleware extends RpcMiddleware.Tag<AuthMiddleware>()(
  "AuthMiddleware",
  {
    wrap: false,
    provides: Auth,
    failure: AuthError,
  }
) {}

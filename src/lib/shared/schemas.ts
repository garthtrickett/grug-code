import { Schema } from "effect";

export const PublicUserSchema = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  email_verified: Schema.Boolean,
  permissions: Schema.Array(Schema.String),
  created_at: Schema.Date,
  avatar_url: Schema.NullOr(Schema.String),
  is_guest: Schema.Boolean,
  display_name: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  skills: Schema.Array(Schema.String),
});

export type PublicUser = Schema.Schema.Type<typeof PublicUserSchema>;

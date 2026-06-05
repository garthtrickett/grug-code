import { Kysely, sql } from "kysely";
import type { Database } from "../types";

export async function up(db: Kysely<Database>) {
  await db.schema
    .createTable("user")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("email", "text", (c) => c.notNull().unique())
    .addColumn("password_hash", "text", (c) => c.notNull())
    .addColumn("permissions", sql`text[]`, (c) => c.defaultTo(sql`'{}'::text[]`))
    .addColumn("avatar_url", "text")
    .addColumn("email_verified", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("phone", "text")
    .addColumn("display_name", "text")
    .addColumn("created_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("platform_admin")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("email", "text", (c) => c.notNull().unique())
    .addColumn("password_hash", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("deck")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("category", "text", (c) => c.notNull().defaultTo("general"))
    .addColumn("content", "jsonb")
    .addColumn("created_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable("srs_card")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull().references("user.id").onDelete("cascade"))
    .addColumn("deck_id", "uuid", (c) => c.notNull().references("deck.id").onDelete("cascade"))
    .addColumn("front", "text", (c) => c.notNull())
    .addColumn("back", "text", (c) => c.notNull())
    .addColumn("audio_url", "text")
    .addColumn("ease_factor", "double precision", (c) => c.notNull().defaultTo(2.5))
    .addColumn("repetitions", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("interval_days", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("next_review", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("created_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("srs_card_user_next_review_idx").on("srs_card").columns(["user_id", "next_review"]).execute();
  await db.schema.createIndex("deck_updated_at_idx").on("deck").column("updated_at").execute();
  await db.schema.createIndex("srs_card_updated_at_idx").on("srs_card").column("updated_at").execute();
}

export async function down(db: Kysely<Database>) {
  await db.schema.dropTable("srs_card").ifExists().execute();
  await db.schema.dropTable("deck").ifExists().execute();
  await db.schema.dropTable("platform_admin").ifExists().execute();
  await db.schema.dropTable("user").ifExists().execute();
}

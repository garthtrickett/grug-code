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
}

export async function down(db: Kysely<Database>) {
  await db.schema.dropTable("platform_admin").ifExists().execute();
  await db.schema.dropTable("user").ifExists().execute();
}

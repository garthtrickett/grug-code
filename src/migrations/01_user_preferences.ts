import { Kysely, sql } from "kysely";
import type { Database } from "../types";

export async function up(db: Kysely<Database>) {
  await db.schema
    .createTable("user_preference")
    .ifNotExists()
    .addColumn("user_id", "uuid", (c) => c.primaryKey().references("user.id").onDelete("cascade"))
        .addColumn("daily_review_limit", "integer", (c) => c.notNull().defaultTo(20))
    .addColumn("daily_new_rule_limit", "integer", (c) => c.notNull().defaultTo(3))
    .addColumn("created_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex("user_preference_updated_at_idx").on("user_preference").column("updated_at").execute();
}

export async function down(db: Kysely<Database>) {
  await db.schema.dropTable("user_preference").ifExists().execute();
}

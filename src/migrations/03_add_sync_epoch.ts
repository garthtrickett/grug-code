import { Kysely, sql } from "kysely";
import type { Database } from "../types";

export async function up(db: Kysely<Database>) {
  // Create a single-row metadata table tracking the database era/epoch
  await db.schema
    .createTable("sync_epoch")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("created_at", "timestamp", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // Seed the initial unique epoch era
  await db
    .insertInto("sync_epoch")
    .values({
      id: sql`gen_random_uuid()`
    })
    .execute();
}

export async function down(db: Kysely<Database>) {
  await db.schema.dropTable("sync_epoch").ifExists().execute();
}

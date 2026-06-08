import { Kysely } from "kysely";
import type { Database } from "../types";

export async function up(db: Kysely<Database>) {
  await db.schema
    .alterTable("project")
    .addColumn("uses_devcontainer", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<Database>) {
  await db.schema
    .alterTable("project")
    .dropColumn("uses_devcontainer")
    .execute();
}

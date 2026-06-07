import { Kysely } from "kysely";
import type { Database } from "../types";

export async function up(db: Kysely<Database>) {
  await db.schema
    .alterTable("project")
    .addColumn("startup_command", "text")
    .execute();
}

export async function down(db: Kysely<Database>) {
  await db.schema
    .alterTable("project")
    .dropColumn("startup_command")
    .execute();
}

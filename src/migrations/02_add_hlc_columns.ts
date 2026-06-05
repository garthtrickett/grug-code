import { Kysely } from "kysely";
import type { Database } from "../types";

export async function up(db: Kysely<Database>) {
  const tables = ["user_preference"] as const;

  for (const table of tables) {
    await db.schema
      .alterTable(table)
      .addColumn("hlc", "text", (c) => c.notNull().defaultTo("0000000000000:0000:initial"))
      .execute();

    await db.schema
      .createIndex(`${table}_hlc_idx`)
      .on(table)
      .column("hlc")
      .execute();
  }
}

export async function down(db: Kysely<Database>) {
  const tables = ["user_preference"] as const;

  for (const table of tables) {
    await db.schema.dropIndex(`${table}_hlc_idx`).ifExists().execute();
    await db.schema.alterTable(table).dropColumn("hlc").execute();
  }
}

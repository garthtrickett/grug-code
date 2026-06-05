import "dotenv/config"; // Ensure variables are loaded before evaluating connection strings
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { Effect } from "effect";
import type { Database } from "../types";

export const makeDbLive = Effect.gen(function* () {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    yield* Effect.logError(
      "[makeDbLive] FATAL: DATABASE_URL must be set"
    );
    throw new Error("DATABASE_URL must be set");
  }

  const redactedUrl = connectionString.replace(/:([^@]+)@/, ":****@");
  yield* Effect.logWarning(
    `[makeDbLive] Initializing Kysely with connection: ${redactedUrl}`
  );

  const dialect = new PostgresDialect({
    pool: new Pool({
      connectionString,
      connectionTimeoutMillis: 5000,
    }),
  });

  return new Kysely<Database>({
    dialect,
    log: (event) => {
      if (event.level === "error") {
        console.error("[Kysely Error]", event.error);
      }
    },
  });
});

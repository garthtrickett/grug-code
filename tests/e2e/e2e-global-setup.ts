import { config } from "dotenv";
import { Pool } from "pg";
import { Kysely, PostgresDialect, Migrator } from "kysely";
import { migrationObjects } from "../../src/db/migrations/migrations-manifest.ts";
import type { Database } from "../../src/types/index.ts";

config({ path: ".env" });

function getConnectionString(dbName: string) {
  const base =
    process.env.DATABASE_URL_TEST ||
    process.env.DATABASE_URL_LOCAL ||
    process.env.DATABASE_URL;
  if (!base) {
    throw new Error("DATABASE_URL_TEST (or LOCAL/default) must be set in .env to run tests.");
  }
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export default async function globalSetup() {
  console.info("⚡ [E2E GlobalSetup] Preparing E2E Test Database...");

  const base =
    process.env.DATABASE_URL_TEST ||
    process.env.DATABASE_URL_LOCAL ||
    process.env.DATABASE_URL;
  if (!base) {
    throw new Error("No database URL found for E2E testing.");
  }
  const url = new URL(base);
  const dbName = url.pathname.slice(1) || "main_test";

  const adminUrl = getConnectionString("postgres");
  const adminPool = new Pool({ connectionString: adminUrl, max: 1 });

  try {
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    console.error("[E2E GlobalSetup] Failed to recreate E2E DB", e);
    throw e;
  } finally {
    await adminPool.end();
  }

  const testDbUrl = getConnectionString(dbName);
  const testDbPool = new Pool({ connectionString: testDbUrl, max: 1 });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: testDbPool }),
  });

  try {
    const migrator = new Migrator({
      db,
      provider: {
        getMigrations: () => Promise.resolve(migrationObjects),
      },
    });

    const { error, results } = await migrator.migrateToLatest();

    if (error) {
      console.error("[E2E GlobalSetup] Migration failed on E2E DB");
      results?.forEach((r) => {
        if (r.status === "Error") console.error(` - ${r.migrationName}: ${r.status}`);
      });
      if (error instanceof Error) {
        throw error;
      }
      const errorMsg = typeof error === "string" ? error : JSON.stringify(error);
      throw new Error(errorMsg);
    }
    console.info("✅ [E2E GlobalSetup] E2E Database Migrated Successfully.");
  } finally {
    await db.destroy();
  }
}

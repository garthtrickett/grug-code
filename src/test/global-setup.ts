import { config } from "dotenv";
import { Pool } from "pg";
import { Kysely, PostgresDialect, Migrator } from "kysely";
import { migrationObjects } from "../db/migrations/migrations-manifest";
import type { Database } from "../types";

config({ path: ".env" });

export const TEMPLATE_DB_NAME = "bedrock_lang_test_template";

function getConnectionString(dbName: string) {
  const base = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!base) {
    throw new Error("DATABASE_URL_TEST (or LOCAL/default) must be set in .env to run tests.");
  }
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export async function setup() {
  console.info("⚡ [GlobalSetup] Preparing Language App Template Database...");
  
  const adminUrl = getConnectionString("postgres");
  const adminPool = new Pool({ connectionString: adminUrl, max: 1 });

  try {
    await adminPool.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}" WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE "${TEMPLATE_DB_NAME}"`);
  } catch (e) {
    console.error("[GlobalSetup] Failed to create template DB", e);
    throw e;
  } finally {
    await adminPool.end();
  }

  const templateUrl = getConnectionString(TEMPLATE_DB_NAME);
  const templatePool = new Pool({ connectionString: templateUrl, max: 1 });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: templatePool }),
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
      console.error("[GlobalSetup] Migration failed on template DB");
      results?.forEach((r) => {
        if (r.status === "Error") console.error(` - ${r.migrationName}: ${r.status}`);
      });
      
      if (error instanceof Error) {
        throw error;
      }
      const errorMsg = typeof error === 'string' ? error : JSON.stringify(error);
      throw new Error(errorMsg);
    }
  } finally {
    await db.destroy();
  }

  console.info("✅ [GlobalSetup] Template Database Ready.");
}

export async function teardown() {
  console.info("🧹 [GlobalTeardown] Cleaning up Template Database...");
  const adminUrl = getConnectionString("postgres");
  const adminPool = new Pool({ connectionString: adminUrl, max: 1 });

  try {
    await adminPool.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}" WITH (FORCE)`);
  } catch (e) {
    console.error("[GlobalTeardown] Failed to drop template DB", e);
  } finally {
    await adminPool.end();
  }
}

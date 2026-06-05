import "dotenv/config";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import Cursor from "pg-cursor";
import type { Database } from "../types";

let _pool: Pool | undefined;
let _db: Kysely<Database> | undefined;

const getConnectionString = (): string => {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "FATAL: DATABASE_URL must be set in environment variables."
    );
  }
  return connectionString;
};

const initPool = (): Pool => {
  if (!_pool) {
    _pool = new Pool({
      connectionString: getConnectionString(),
      connectionTimeoutMillis: 5000,
    });
  }
  return _pool;
};

export const initDb = (): Kysely<Database> => {
  if (!_db) {
    const dialect = new PostgresDialect({
      pool: initPool(),
      cursor: Cursor,
    });
    _db = new Kysely<Database>({
      dialect,
      log: (event) => {
        if (event.level === "error") {
          console.error("[DB Error]", event.error);
        }
      },
    });
  }
  return _db;
};

// Proxy to allow lazy initialization (especially useful across test environments)
export const db = new Proxy({} as Kysely<Database>, {
  get(_target, prop) {
    const d = initDb();
    const key = prop as keyof Kysely<Database>;
        const value = d[key];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-unsafe-return
    return typeof value === "function" ? (value as Function).bind(d) : value;
  },
});

// Backward-compatibility aliases
export const centralDb = db;

export const closeDb = async (): Promise<void> => {
  if (_db) {
    await _db.destroy();
    _db = undefined;
    _pool = undefined;
  } else if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
};

export const closeCentralDb = closeDb;

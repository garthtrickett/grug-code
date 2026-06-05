require("dotenv").config();
const { makeKyselyHook } = require("kanel-kysely");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "[.kanelrc.cjs] DATABASE_URL is not defined."
  );
}
const dbUrl = new URL(process.env.DATABASE_URL);
const connectionConfig = {
  host: dbUrl.hostname,
  port: dbUrl.port ? parseInt(dbUrl.port, 10) : 5432,
  user: dbUrl.username,
  password: dbUrl.password,
  database: dbUrl.pathname.slice(1),
};

if (dbUrl.hostname !== "localhost" && dbUrl.hostname !== "127.0.0.1") {
  connectionConfig.ssl = { rejectUnauthorized: false };
}

/** @type {import('kanel').Config} */
module.exports = {
  connection: connectionConfig,

  schemas: ["public"],

  typeFilter: (pgType) => {
    const lowerName = pgType.name.toLowerCase();
    return (
      lowerName !== "kysely_migration_lock" && lowerName !== "kysely_migration"
    );
  },

  outputPath: "./src/types/generated",

  preDeleteOutputFolder: true,
  preRenderHooks: [makeKyselyHook()],
};

import { Pool } from "pg";
import { TEMPLATE_DB_NAME } from "./global-setup";

function getConnectionString(dbName: string = "postgres") {
  const base = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
  if (!base) {
    throw new Error("DATABASE_URL_TEST (or LOCAL/default) must be set in .env to run tests.");
  }
  
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export async function setupWorkerDb(workerId: number | string): Promise<string> {
  const id = workerId ?? "main";
  const dbName = `bedrock_lang_test_${id}`;
  const adminUrl = getConnectionString("postgres");

  const adminPool = new Pool({ 
    connectionString: adminUrl, 
    max: 1,
    connectionTimeoutMillis: 5000 
  });

  try {
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB_NAME}"`);
  } catch (e) {
    console.error(`[WorkerSetup] Failed to clone database ${dbName} from template`, e);
    throw e;
  } finally {
    await adminPool.end();
  }

  return getConnectionString(dbName);
}

export async function teardownWorkerDb(workerId: number | string) {
  const id = workerId ?? "main";
  const dbName = `bedrock_lang_test_${id}`;
  const adminUrl = getConnectionString("postgres");
  
  const adminPool = new Pool({ 
    connectionString: adminUrl, 
    max: 1 
  });

  try {
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch (e) {
    console.error(`[WorkerSetup] Failed to teardown database ${dbName}`, e);
  } finally {
    await adminPool.end();
  }
}

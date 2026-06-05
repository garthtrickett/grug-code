import "fake-indexeddb/auto";
import { beforeAll, afterAll } from "vitest";
import { setupWorkerDb, teardownWorkerDb } from "./worker-db-setup";
import { closeCentralDb } from "../db/client";

const workerId = process.env.VITEST_WORKER_ID || "1";

beforeAll(async () => {
  const connectionString = await setupWorkerDb(workerId);

  process.env.DATABASE_URL = connectionString;
  process.env.DATABASE_URL_LOCAL = connectionString;
});

afterAll(async () => {
  await closeCentralDb();
  await teardownWorkerDb(workerId);
});

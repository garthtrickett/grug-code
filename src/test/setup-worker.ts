import "fake-indexeddb/auto";
import { beforeAll, afterAll } from "vitest";
import { setupWorkerDb, teardownWorkerDb } from "./worker-db-setup";
import { closeCentralDb } from "../db/client";
import * as fs from "node:fs/promises";

// Safe cross-runtime Bun polyfill for Vitest running under Node
const globalObj = globalThis as typeof globalThis & {
  Bun?: {
    file: (path: string) => { text: () => Promise<string> };
    write: (path: string, content: string) => Promise<void>;
    env: typeof process.env;
    gc: () => void;
  };
};

if (typeof globalObj.Bun === "undefined") {
  console.info("[setup-worker] Polyfilling global Bun object for Node compatibility...");
  globalObj.Bun = {
    file: (path: string) => ({
      text: () => fs.readFile(path, "utf-8"),
    }),
    write: (path: string, content: string) => fs.writeFile(path, content, "utf-8"),
    env: process.env,
    gc: () => {},
  };
}

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

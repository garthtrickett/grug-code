import "fake-indexeddb/auto";
import { beforeAll, afterAll } from "vitest";
import { setupWorkerDb, teardownWorkerDb } from "./worker-db-setup";
import { closeCentralDb } from "../db/client";
import * as fs from "node:fs/promises";

// Safe cross-runtime Bun polyfill for Vitest running under Node
class MockGlob {
  constructor(_pattern: string) {}
  scanSync(_options?: unknown): string[] {
    return [];
  }
  scan(_options?: unknown): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            return Promise.resolve({ done: true, value: undefined as unknown as string });
          }
        };
      }
    };
  }
  match(_path: string): boolean {
    return false;
  }
}

const mockBun = {
  file: (path: string | URL) => ({
    text: () => fs.readFile(typeof path === "string" ? path : path.toString(), "utf-8"),
  }),
  write: (path: unknown, content: unknown) => {
    const destination = typeof path === "string" ? path : String(path);
    const data = typeof content === "string" ? content : String(content);
    return fs.writeFile(destination, data, "utf-8");
  },
  env: process.env,
  gc: () => {},
  Glob: MockGlob,
};

if (typeof (globalThis as unknown as Record<string, unknown>)["Bun"] === "undefined") {
  console.info("[setup-worker] Polyfilling global Bun object for Node compatibility...");
  (globalThis as unknown as Record<string, unknown>)["Bun"] = mockBun;
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

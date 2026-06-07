import "fake-indexeddb/auto";
import { beforeAll, afterAll } from "vitest";
import { setupWorkerDb, teardownWorkerDb } from "./worker-db-setup";
import { closeCentralDb } from "../db/client";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as fsSync from "node:fs";
import { ReadableStream } from "node:stream/web";

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

interface MockServeOptions {
  port?: number;
  unix?: string;
  idleTimeout?: number;
  fetch?: (request: Request) => Promise<Response>;
  error?: (error: Error) => void;
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
  serve: (options?: MockServeOptions) => {
    if (!options || !options.fetch) {
      return {
        port: options?.port === 0 ? 3001 : (options?.port || 0),
        hostname: "localhost",
        stop: () => Promise.resolve(),
        reload: () => {},
      };
    }

    const server = http.createServer((req, res) => {
      const chunks: Uint8Array[] = [];
      req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      req.on("end", () => {
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        const protocol = req.headers["x-forwarded-proto"] as string || "http";
        const host = req.headers.host || "localhost";
        const url = new URL(req.url || "", `${protocol}://${host}`);

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value !== undefined) {
            if (Array.isArray(value)) {
              for (const v of value) {
                headers.append(key, v);
              }
            } else {
              headers.append(key, value);
            }
          }
        }

        const webReq = new Request(url.toString(), {
          method: req.method,
          headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
        });

        options.fetch!(webReq)
          .then(async (webRes) => {
            res.statusCode = webRes.status;
            webRes.headers.forEach((value, key) => {
              res.setHeader(key, value);
            });

            if (webRes.body) {
              const reader = webRes.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            }
            res.end();
          })
          .catch((err: Error) => {
            if (options.error) {
              options.error(err);
            }
            res.statusCode = 500;
            res.end(err.message);
          });
      });
    });

    const listenTarget = options.unix || options.port || 0;
    server.listen(listenTarget);

    return {
      get port(): number {
        const addr = server.address();
        return typeof addr === "object" && addr ? addr.port : 0;
      },
      get hostname(): string {
        return "localhost";
      },
      stop: () => new Promise<void>((resolve) => {
        server.close(() => {
          if (options.unix) {
            try {
              fsSync.unlinkSync(options.unix);
            } catch {
              // Ignore cleanup issues
            }
          }
          resolve();
        });
      }),
      reload: (newOptions?: MockServeOptions) => {
        if (newOptions) {
          options = { ...options, ...newOptions };
        }
      },
    };
  },
  env: process.env,
  gc: () => {},
  Glob: MockGlob,
};

if (typeof (globalThis as unknown as Record<string, unknown>)["Bun"] === "undefined") {
  console.info("[setup-worker] Polyfilling global Bun object for Node compatibility...");
  (globalThis as unknown as Record<string, unknown>)["Bun"] = mockBun;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit & { unix?: string }): Promise<Response> => {
  if (init && init.unix) {
    const url = new URL(input.toString());
    return new Promise<Response>((resolve, reject) => {
      const req = http.request({
        socketPath: init.unix,
        path: url.pathname + url.search,
        method: init.method || "GET",
        headers: init.headers as Record<string, string>,
      }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) {
              if (Array.isArray(value)) {
                for (const v of value) {
                  responseHeaders.append(key, v);
                }
              } else {
                responseHeaders.append(key, value);
              }
            }
          }

          const response = new Response(body, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: responseHeaders,
          });

          Object.defineProperty(response, "body", {
            get() {
              return new ReadableStream<Uint8Array>({
                start(controller) {
                  res.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
                  res.on("end", () => controller.close());
                  res.on("error", (err) => controller.error(err));
                }
              });
            },
            configurable: true,
          });

          resolve(response);
        });
      });
      req.on("error", reject);
      if (init.body) {
        if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
          req.write(init.body);
        } else {
          req.write(String(init.body));
        }
      }
      req.end();
    });
  }
  return originalFetch(input, init);
};

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

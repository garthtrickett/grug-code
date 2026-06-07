import "fake-indexeddb/auto";
import { beforeAll, afterAll } from "vitest";
import { setupWorkerDb, teardownWorkerDb } from "./worker-db-setup";
import { closeCentralDb } from "../db/client";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as fsSync from "node:fs";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";

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
    const state = { opts: options || {} };
    if (!state.opts.fetch) {
      return {
        port: state.opts.port === 0 ? 3001 : (state.opts.port || 0),
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

        const fetchHandler = state.opts.fetch;
        if (fetchHandler) {
          console.info("[mockBun.serve] Dispatching request to Elysia: " + req.method + " " + url.pathname);
          fetchHandler(webReq)
            .then(async (webRes) => {
              console.info("[mockBun.serve] Elysia returned response: status=" + webRes.status + " for " + url.pathname);
              res.statusCode = webRes.status;
              webRes.headers.forEach((value, key) => {
                res.setHeader(key, value);
              });

              // Flush status and headers immediately to avoid buffering/deadlock on streaming responses
              console.info("[mockBun.serve] Flushing status & headers to socket for " + url.pathname);
              res.writeHead(webRes.status);

              if (webRes.body) {
                const reader = webRes.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) {
                    console.info("[mockBun.serve] Body stream reader done for " + url.pathname);
                    break;
                  }
                  console.info("[mockBun.serve] Writing " + value.length + " bytes of chunk to socket for " + url.pathname);
                  res.write(value);
                }
              }
              console.info("[mockBun.serve] Closing response connection for " + url.pathname);
              res.end();
            })
            .catch((err: Error) => {
              console.error("[mockBun.serve] Elysia handler threw error for " + url.pathname, err);
              const errorHandler = state.opts.error;
              if (errorHandler) {
                errorHandler(err);
              }
              res.statusCode = 500;
              res.end(err.message);
            });
        } else {
          console.warn("[mockBun.serve] No fetch handler configured on mock server");
          res.statusCode = 500;
          res.end("No fetch handler configured on mock server");
        }
      });
    });

    const listenTarget = state.opts.unix || state.opts.port || 0;
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
        const s = server as unknown as { closeAllConnections?: () => void };
        if (typeof s.closeAllConnections === "function") {
          s.closeAllConnections();
        }
        server.close(() => {
          const unixPath = state.opts.unix;
          if (unixPath) {
            try {
              fsSync.unlinkSync(unixPath);
            } catch {
              // Ignore cleanup issues
            }
          }
          resolve();
        });
      }),
      reload: (newOptions?: MockServeOptions) => {
        if (newOptions) {
          state.opts = { ...state.opts, ...newOptions };
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

const getUrlString = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if ("href" in input) {
    return input.href;
  }
  return input.url;
};

const safeStringifyBody = (body: unknown): string | Buffer => {
  if (typeof body === "string") {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body && typeof body === "object" && "toString" in body) {
    const str = (body as { toString(): string }).toString();
    if (str !== "[object Object]") {
      return str;
    }
  }
  return "";
};

const originalFetch = globalThis.fetch;
const customFetch = async (input: RequestInfo | URL, init?: RequestInit & { unix?: string }): Promise<Response> => {
  if (init && init.unix) {
    const urlString = getUrlString(input);
    const url = new URL(urlString);
    console.info("[customFetch] Intercepted UNIX socket request to: " + url.pathname + " via socket: " + init.unix);
    return new Promise<Response>((resolve, reject) => {
      const req = http.request({
        socketPath: init.unix,
        path: url.pathname + url.search,
        method: init.method || "GET",
        headers: init.headers as Record<string, string>,
      }, (res) => {
        console.info("[customFetch] Received response metadata from socket. Status: " + res.statusCode + ", Content-Type: " + (res.headers["content-type"] || "none") + " for " + url.pathname);
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

        const contentType = res.headers["content-type"] || "";
        const isEventStream = contentType.includes("text/event-stream");

        if (isEventStream) {
          console.info("[customFetch] Detected Event Stream (SSE). Resolving Response immediately to enable streaming read.");
          const bodyStream = new ReadableStream<Uint8Array>({
            start(controller: ReadableStreamDefaultController) {
              res.on("data", (chunk: Uint8Array) => {
                console.info("[customFetch] SSE chunk received: size=" + chunk.length + " for " + url.pathname);
                controller.enqueue(new Uint8Array(chunk));
              });
              res.on("end", () => {
                console.info("[customFetch] SSE stream ended for " + url.pathname);
                controller.close();
              });
              res.on("error", (err) => {
                console.error("[customFetch] SSE stream error for " + url.pathname, err);
                controller.error(err);
              });
            },
            cancel() {
              console.info("[customFetch] SSE stream canceled by client for " + url.pathname);
              res.destroy();
            }
          });

          const response = new Response(bodyStream as unknown as BodyInit, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: responseHeaders,
          });

          resolve(response);
          return;
        }

        console.info("[customFetch] Standard request detected. Buffering entire response for " + url.pathname);
        const chunks: Uint8Array[] = [];
        res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          console.info("[customFetch] Buffering complete for standard request. Resolved Response with size=" + body.length + " for " + url.pathname);
          const response = new Response(body, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: responseHeaders,
          });

          Object.defineProperty(response, "body", {
            get() {
              return new ReadableStream<Uint8Array>({
                start(controller: ReadableStreamDefaultController) {
                  controller.enqueue(new Uint8Array(body));
                  controller.close();
                }
              });
            },
            configurable: true,
          });

          resolve(response);
        });
      });
      req.on("error", (err) => {
        console.error("[customFetch] UNIX socket request failed for " + url.pathname, err);
        reject(err);
      });
      if (init.body) {
        req.write(safeStringifyBody(init.body));
      }
      req.end();
    });
  }
  return originalFetch(input, init);
};

globalThis.fetch = Object.assign(customFetch, originalFetch);

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

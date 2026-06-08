import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { runCli } from "../src/cli.ts";

vi.mock("@clack/prompts", () => {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    spinner: vi.fn(),
    isCancel: vi.fn(),
    cancel: vi.fn(),
    note: vi.fn(),
  };
});

describe("Interactive CLI Logs Tailing", () => {
  const originalFetch = global.fetch;
  const originalExit = process.exit;
  const originalArgv = process.argv;
  const originalStdoutWrite = process.stdout.write;

  let stdoutWritten = "";

  beforeEach(() => {
    vi.clearAllMocks();
    process.exit = vi.fn() as any;
    stdoutWritten = "";
    process.stdout.write = vi.fn().mockImplementation((data: string) => {
      stdoutWritten += data;
      return true;
    }) as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    global.fetch = originalFetch;
    process.argv = originalArgv;
    process.stdout.write = originalStdoutWrite;
  });

  it("should connect to SSE endpoint, decode frames, filter by taskId, write matching messages to stdout, and exit cleanly", async () => {
    process.argv = ["node", "grug", "logs", "task-logs-123"];

    const mockSseStream = {
      getReader: () => {
        let count = 0;
        return {
          read: () => {
            count++;
            if (count === 1) {
              const matchingProgressNotification = {
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: {
                  progressToken: "task-logs-123",
                  progress: 1,
                  message: "compiling workspace files...\n",
                },
              };
              const frame = `data: ${JSON.stringify(matchingProgressNotification)}\n\n`;
              return Promise.resolve({
                value: new TextEncoder().encode(frame),
                done: false,
              });
            }
            if (count === 2) {
              const nonMatchingProgressNotification = {
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: {
                  progressToken: "other-task-id",
                  progress: 2,
                  message: "this should be filtered out",
                },
              };
              const frame = `data: ${JSON.stringify(nonMatchingProgressNotification)}\n\n`;
              return Promise.resolve({
                value: new TextEncoder().encode(frame),
                done: false,
              });
            }
            return Promise.resolve({
              value: undefined,
              done: true,
            });
          },
          cancel: () => Promise.resolve(),
        };
      },
    };

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/mcp/sse")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: mockSseStream,
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as any;

    await Effect.runPromise(runCli());

    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/mcp/sse"));
    expect(process.stdout.write).toHaveBeenCalled();
    expect(stdoutWritten).toContain("compiling workspace files...");
    expect(stdoutWritten).not.toContain("this should be filtered out");
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
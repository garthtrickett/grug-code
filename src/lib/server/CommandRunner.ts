import { Effect } from "effect";
import type { VerificationResult, DirtyFile } from "./WorkspaceController";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { progressBroadcaster } from "./WorkspaceController";
import { config } from "./Config";

export interface CommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
  readonly startupCommand?: string;
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
}

export interface CommandResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface CommandRunner {
  readonly run: (args: string[], options?: CommandOptions) => Effect.Effect<CommandResult, Error>;
  readonly runTypeCheck: (
    cwd?: string,
    timeoutMs?: number,
    customCommand?: string,
    startupCommand?: string,
    onStdout?: (data: string) => void,
    onStderr?: (data: string) => void
  ) => Effect.Effect<VerificationResult, Error>;
  readonly runLintCheck: (
    cwd?: string,
    timeoutMs?: number,
    customCommand?: string,
    startupCommand?: string,
    onStdout?: (data: string) => void,
    onStderr?: (data: string) => void
  ) => Effect.Effect<VerificationResult, Error>;
  readonly runTestSuite: (
    cwd?: string,
    timeoutMs?: number,
    customCommand?: string,
    startupCommand?: string,
    onStdout?: (data: string) => void,
    onStderr?: (data: string) => void
  ) => Effect.Effect<VerificationResult, Error>;
}

export const parseTscErrors = (output: string): readonly string[] => {
  const files = new Set<string>();
  // Match Format 1: path/file.ts(line,col): error ...
  const regex1 = /^([^\s\(\)]+)\(\d+,\d+\):\s+error/gm;
  let match;
  while ((match = regex1.exec(output)) !== null) {
    if (match[1]) files.add(match[1].trim());
  }
  // Match Format 2: path/file.ts:line:col - error ...
  const regex2 = /^([^\s:]+):\d+:\d+\s+-\s+error/gm;
  while ((match = regex2.exec(output)) !== null) {
    if (match[1]) files.add(match[1].trim());
  }
  return Array.from(files);
};

export const parseCommandString = (cmdStr: string): string[] => {
  return cmdStr.trim().split(/\s+/).filter(Boolean);
};

export const parseTestFailures = (output: string): readonly string[] => {
  const files = new Set<string>();
  // Catch any common test file suffixes like some.test.ts or other.spec.js
  const testFileRegex = /([a-zA-Z0-9_\-\/]+\.(?:test|spec)\.(?:ts|js|tsx|jsx))/g;
  let match;
  while ((match = testFileRegex.exec(output)) !== null) {
    if (match[1]) files.add(match[1].trim());
  }
  return Array.from(files);
};

const getDirtyFilesFromGit = (cwd?: string) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("[CommandRunner] Gathering dirty files context via git diff...");
    
    const result = yield* Effect.tryPromise({
      try: () => new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
        const child = spawn("git", ["diff", "--name-only"], { cwd });
        let stdout = "";
        child.stdout?.on("data", (chunk: unknown) => {
          if (Buffer.isBuffer(chunk)) {
            stdout += chunk.toString("utf-8");
          } else if (typeof chunk === "string") {
            stdout += chunk;
          } else {
            stdout += String(chunk);
          }
        });
        child.on("close", (code) => {
          resolve({ exitCode: code ?? 0, stdout });
        });
        child.on("error", (err) => {
          reject(err);
        });
      }),
      catch: (e) => new Error(`Git diff command failed: ${String(e)}`),
    });

    if (result.exitCode !== 0) return [];

    const files = result.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    const dirty: DirtyFile[] = [];
    for (const file of files) {
      const filePath = cwd ? `${cwd}/${file}` : file;
      const content = yield* Effect.tryPromise({
        try: () => fs.readFile(filePath, "utf-8"),
        catch: (e) => new Error(`Failed to read file: ${String(e)}`),
      }).pipe(Effect.catchAll(() => Effect.succeed("")));
      dirty.push({ filePath: file, content });
    }
    return dirty;
  });

export const makeCommandRunner = (): CommandRunner => {
  const run = (args: string[], options?: CommandOptions) =>
    Effect.gen(function* () {
      let [command, ...cmdArgs] = args;
      if (!command) {
        return yield* Effect.fail(new Error("No command provided"));
      }

      if (options?.startupCommand) {
        const startupArgs = parseCommandString(options.startupCommand);
        if (startupArgs.length > 0) {
          const startupHead = startupArgs[0]!;
          const startupTail = startupArgs.slice(1);
          const isNixDevelop = startupHead === "nix" && startupTail[0] === "develop";
          if (isNixDevelop) {
            const hasCommandFlag = startupTail.includes("-c") || startupTail.includes("--command");
            if (hasCommandFlag) {
              cmdArgs = [...startupTail, command, ...cmdArgs];
            } else {
              cmdArgs = [...startupTail, "-c", command, ...cmdArgs];
            }
          } else {
            cmdArgs = [...startupTail, command, ...cmdArgs];
          }
          command = startupHead;
        }
      }

      yield* Effect.logInfo(`[CommandRunner] Spawning subprocess: ${command} ${cmdArgs.join(" ")}`);

      const env = { ...process.env, ...options?.env };

      const result = yield* Effect.tryPromise({
        try: () => new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
          const child = spawn(command, cmdArgs, {
            cwd: options?.cwd,
            env,
          });

          let stdout = "";
          let stderr = "";
          let timedOut = false;

          let timer: NodeJS.Timeout | undefined;
          if (options?.timeoutMs) {
            timer = setTimeout(() => {
              timedOut = true;
              child.kill();
              resolve({ exitCode: -1, stdout, stderr, timedOut: true });
            }, options.timeoutMs);
          }

                    child.stdout?.on("data", (chunk: unknown) => {
            const text = Buffer.isBuffer(chunk)
              ? chunk.toString("utf-8")
              : typeof chunk === "string"
                ? chunk
                : String(chunk);
            stdout += text;
            if (options?.onStdout) {
              options.onStdout(text);
            }
            progressBroadcaster.emit("progress", JSON.stringify({ type: "stdout", text }));
          });

          child.stderr?.on("data", (chunk: unknown) => {
            const text = Buffer.isBuffer(chunk)
              ? chunk.toString("utf-8")
              : typeof chunk === "string"
                ? chunk
                : String(chunk);
            stderr += text;
            if (options?.onStderr) {
              options.onStderr(text);
            }
            progressBroadcaster.emit("progress", JSON.stringify({ type: "stderr", text }));
          });

          child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            resolve({ exitCode: code ?? 0, stdout, stderr, timedOut });
          });

          child.on("error", (err) => {
            if (timer) clearTimeout(timer); 
            reject(err);
          });
        }),
        catch: (e) => new Error(`Subprocess terminated unexpectedly: ${String(e)}`),
      });

      return {
        success: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    });

  return {
    run,

        runTypeCheck: (cwd?: string, timeoutMs?: number, customCommand?: string, startupCommand?: string, onStdout?: (data: string) => void, onStderr?: (data: string) => void) =>
      Effect.gen(function* () {
        const args = customCommand ? parseCommandString(customCommand) : ["bun", "x", "tsc", "--noEmit"];
        const result = yield* run(args, { cwd, timeoutMs: timeoutMs ?? 30000, startupCommand, onStdout, onStderr });
        
        if (result.success) {
          return { success: true, dirtyFiles: [] };
        }

        yield* Effect.logWarning("[CommandRunner] Typecheck failed. Extracting file context...");
        const dirtyFiles = yield* getDirtyFilesFromGit(cwd);
        return {
          success: false,
          errorOutput: result.stdout + "\n" + result.stderr,
          dirtyFiles,
        };
      }),

        runLintCheck: (cwd?: string, timeoutMs?: number, customCommand?: string, startupCommand?: string, onStdout?: (data: string) => void, onStderr?: (data: string) => void) =>
      Effect.gen(function* () {
        if (!customCommand) {
          return { success: true, dirtyFiles: [] };
        }
        const args = parseCommandString(customCommand);
        const result = yield* run(args, { cwd, timeoutMs: timeoutMs ?? 30000, startupCommand, onStdout, onStderr });
        
        if (result.success) {
          return { success: true, dirtyFiles: [] };
        }

        yield* Effect.logWarning("[CommandRunner] Lint check failed. Extracting file context...");
        const dirtyFiles = yield* getDirtyFilesFromGit(cwd);
        return {
          success: false,
          errorOutput: result.stdout + "\n" + result.stderr,
          dirtyFiles,
        };
      }),

        runTestSuite: (cwd?: string, timeoutMs?: number, customCommand?: string, startupCommand?: string, onStdout?: (data: string) => void, onStderr?: (data: string) => void) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("[CommandRunner] Running operational test suites execution pass...");
        const args = customCommand ? parseCommandString(customCommand) : ["bun", "run", "test"];

        const shiftedPort = String(3100 + Math.floor(Math.random() * 1000));
        const shiftedBackendPort = String(4300 + Math.floor(Math.random() * 1000));

        const envOverrides: Record<string, string> = {
          NODE_ENV: "test",
          PORT: shiftedPort,
          BACKEND_PORT: shiftedBackendPort,
        };

        const result = yield* run(args, { 
          cwd, 
          timeoutMs: timeoutMs ?? 45000,
          env: envOverrides,
          startupCommand,
          onStdout,
          onStderr,
        });

        if (result.success) {
          return { success: true, dirtyFiles: [] };
        }

        yield* Effect.logWarning(`[CommandRunner] Testing suites failed. Output:\n${result.stdout}\n${result.stderr}`);
        const dirtyFiles = yield* getDirtyFilesFromGit(cwd);
        return {
          success: false,
          errorOutput: result.stdout + "\n" + result.stderr,
          dirtyFiles,
        };
      }),
  };
};

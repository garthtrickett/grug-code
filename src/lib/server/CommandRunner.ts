import { Effect } from "effect";
import type { VerificationResult, DirtyFile } from "./WorkspaceController";

export interface CommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
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
  readonly runTypeCheck: (cwd?: string, timeoutMs?: number) => Effect.Effect<VerificationResult, Error>;
  readonly runTestSuite: (cwd?: string, timeoutMs?: number) => Effect.Effect<VerificationResult, Error>;
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
    const process = Bun.spawn(["git", "diff", "--name-only"], { cwd });
    const stdout = yield* Effect.promise(() => new Response(process.stdout).text());
    const exitCode = yield* Effect.promise(() => process.exited);
    if (exitCode !== 0) return [];

    const files = stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    const dirty: DirtyFile[] = [];
    for (const file of files) {
      const filePath = cwd ? `${cwd}/${file}` : file;
      const content = yield* Effect.tryPromise({
        try: () => Bun.file(filePath).text(),
        catch: (e) => new Error(`Failed to read file: ${String(e)}`),
      }).pipe(Effect.catchAll(() => Effect.succeed("")));
      dirty.push({ filePath: file, content });
    }
    return dirty;
  });

export const makeCommandRunner = (): CommandRunner => {
  const run = (args: string[], options?: CommandOptions) =>
    Effect.gen(function* () {
      yield* Effect.logInfo(`[CommandRunner] Spawning subprocess: ${args.join(" ")}`);

      const process = Bun.spawn(args, {
        cwd: options?.cwd,
        env: { ...Bun.env, ...options?.env } as Record<string, string>,
      });

      let timer: Timer | undefined;
      let timedOut = false;

      const exitPromise = process.exited;
      const timeoutPromise = new Promise<number>((resolve) => {
        if (!options?.timeoutMs) return;
        timer = setTimeout(() => {
          timedOut = true;
          process.kill();
          resolve(-1);
        }, options.timeoutMs);
      });

      const exitCode = yield* Effect.tryPromise({
        try: () => Promise.race([exitPromise, timeoutPromise]),
        catch: (e) => new Error(`Subprocess terminated unexpectedly: ${String(e)}`),
      });

      if (timer) clearTimeout(timer);

            const stdout = yield* Effect.tryPromise({
        try: () => new Response(process.stdout).text(),
        catch: (e) => new Error(`Failed to read stdout: ${String(e)}`),
      });

      const stderr = yield* Effect.tryPromise({
        try: () => new Response(process.stderr).text(),
        catch: (e) => new Error(`Failed to read stderr: ${String(e)}`),
      });

      return {
        success: exitCode === 0 && !timedOut,
        exitCode,
        stdout,
        stderr,
        timedOut,
      };
    });

  return {
    run,

        runTypeCheck: (cwd?: string, timeoutMs?: number) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("[CommandRunner] Initiating type-safety static verification pass...");
        const result = yield* run(["bun", "x", "tsc", "--noEmit"], { cwd, timeoutMs: timeoutMs ?? 30000 });
        
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

        runTestSuite: (cwd?: string, timeoutMs?: number) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("[CommandRunner] Initiating operational test suites execution pass...");
        const result = yield* run(["bun", "test"], { cwd, timeoutMs: timeoutMs ?? 45000 });

        if (result.success) {
          return { success: true, dirtyFiles: [] };
        }

        yield* Effect.logWarning("[CommandRunner] Testing suites failed. Extracting file context...");
        const dirtyFiles = yield* getDirtyFilesFromGit(cwd);
        return {
          success: false,
          errorOutput: result.stdout + "\n" + result.stderr,
          dirtyFiles,
        };
      }),
  };
};

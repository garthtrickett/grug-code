import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TokenEstimatorLive } from "./TokenEstimator.ts";

describe("SurgicalRouter - Route Specification & Code Paths", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), `.grug-router-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Explicitly stub standard defaults to ensure test isolation from local .env config
    vi.stubEnv("SURGICAL_ROUTER_FILE_LIMIT", "3");
    vi.stubEnv("SURGICAL_ROUTER_TOKEN_LIMIT", "20000");
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("should fail with validation error when target list is empty", async () => {
    const { SurgicalRouterLive, SurgicalRouter } = await import("./SurgicalRouter.ts");
    const program = Effect.gen(function* () {
      const router = yield* SurgicalRouter;
      yield* router.routeExecution([]);
    }).pipe(
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    const result = await Effect.runPromise(Effect.either(program));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const err = result.left as Error;
      expect(err.message).toContain("target files array cannot be empty");
    }
  });

  it("should route to DIRECT for <= default file limit and default token limit", async () => {
    const { SurgicalRouterLive, SurgicalRouter } = await import("./SurgicalRouter.ts");
    const file1 = path.join(tempDir, "a.ts");
    const file2 = path.join(tempDir, "b.ts");
    await fs.writeFile(file1, "const x = 1;");
    await fs.writeFile(file2, "const y = 2;");

    const program = Effect.gen(function* () {
      const router = yield* SurgicalRouter;
      const decision = yield* router.routeExecution([file1, file2]);
      expect(decision.path).toBe("DIRECT");
    }).pipe(
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    await Effect.runPromise(program);
  });

  it("should route to SURGICAL when file count exceeds default file limit", async () => {
    const { SurgicalRouterLive, SurgicalRouter } = await import("./SurgicalRouter.ts");
    const file1 = path.join(tempDir, "1.ts");
    const file2 = path.join(tempDir, "2.ts");
    const file3 = path.join(tempDir, "3.ts");
    const file4 = path.join(tempDir, "4.ts");

    await fs.writeFile(file1, "const a = 1;");
    await fs.writeFile(file2, "const b = 2;");
    await fs.writeFile(file3, "const c = 3;");
    await fs.writeFile(file4, "const d = 4;");

    const program = Effect.gen(function* () {
      const router = yield* SurgicalRouter;
      const decision = yield* router.routeExecution([file1, file2, file3, file4]);
      expect(decision.path).toBe("SURGICAL");
      if (decision.path === "SURGICAL") {
        expect(decision.reason).toContain("File count exceeds the direct routing threshold");
        expect(decision.reason).toContain("Limit: 3");
      } 
    }).pipe(
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    await Effect.runPromise(program);
  });

  it("should route to SURGICAL when total estimated tokens exceed default token limit", async () => { 
    const { SurgicalRouterLive, SurgicalRouter } = await import("./SurgicalRouter.ts");
    const file1 = path.join(tempDir, "heavy.ts");
    const content = "word ".repeat(25000);
    await fs.writeFile(file1, content);

    const program = Effect.gen(function* () {
      const router = yield* SurgicalRouter;
      const decision = yield* router.routeExecution([file1]);
      expect(decision.path).toBe("SURGICAL");
      if (decision.path === "SURGICAL") {
        expect(decision.reason).toContain("Aggregate token size exceeds direct budget of 20,000 tokens");
        expect(decision.reason).toContain("Limit: 20000");
      }
    }).pipe(
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    await Effect.runPromise(program);
  });

  it("should route to SURGICAL with custom file limit set via environment variables", async () => {
    vi.stubEnv("SURGICAL_ROUTER_FILE_LIMIT", "1");
    vi.resetModules();
    const { SurgicalRouterLive, SurgicalRouter } = await import("./SurgicalRouter.ts");

    const file1 = path.join(tempDir, "1.ts");
    const file2 = path.join(tempDir, "2.ts");
    await fs.writeFile(file1, "const a = 1;");
    await fs.writeFile(file2, "const b = 2;");

    const program = Effect.gen(function* () {
      const router = yield* SurgicalRouter;
      const decision = yield* router.routeExecution([file1, file2]);
      expect(decision.path).toBe("SURGICAL");
      if (decision.path === "SURGICAL") {
        expect(decision.reason).toContain("File count exceeds the direct routing threshold");
        expect(decision.reason).toContain("Limit: 1");
      }
    }).pipe(
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    await Effect.runPromise(program);
  });

  it("should route to SURGICAL with custom token limit set via environment variables", async () => {
    vi.stubEnv("SURGICAL_ROUTER_TOKEN_LIMIT", "500");
    vi.resetModules();
    const { SurgicalRouterLive, SurgicalRouter } = await import("./SurgicalRouter.ts");

    const file1 = path.join(tempDir, "test.ts");
    const content = "word ".repeat(600);
    await fs.writeFile(file1, content);

    const program = Effect.gen(function* () {
      const router = yield* SurgicalRouter;
      const decision = yield* router.routeExecution([file1]);
      expect(decision.path).toBe("SURGICAL");
      if (decision.path === "SURGICAL") {
        expect(decision.reason).toContain("Aggregate token size exceeds direct budget of 500 tokens");
        expect(decision.reason).toContain("Limit: 500");
      }
    }).pipe(
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    await Effect.runPromise(program);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SurgicalRouter, SurgicalRouterLive } from "./SurgicalRouter";
import { TokenEstimatorLive } from "./TokenEstimator";

describe("SurgicalRouter - Route Specification & Code Paths", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), `.grug-router-test-${crypto.randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should fail with validation error when target list is empty", async () => {
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
      expect(result.left.message).toContain("target files array cannot be empty");
    }
  });

  it("should route to DIRECT for <= 3 files and <= 20,000 tokens", async () => {
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

  it("should route to SURGICAL when file count exceeds 3", async () => {
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
      } 
    }).pipe(
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    await Effect.runPromise(program);
  });

  it("should route to SURGICAL when total estimated tokens exceed 20,000", async () => {
    const file1 = path.join(tempDir, "heavy.ts");
    const content = "word ".repeat(25000);
    await fs.writeFile(file1, content);

    const program = Effect.gen(function* () {
      const router = yield* SurgicalRouter;
      const decision = yield* router.routeExecution([file1]);
      expect(decision.path).toBe("SURGICAL");
      if (decision.path === "SURGICAL") {
        expect(decision.reason).toContain("Aggregate token size exceeds direct budget");
      }
    }).pipe(
      Effect.provide(SurgicalRouterLive),
      Effect.provide(TokenEstimatorLive)
    );

    await Effect.runPromise(program);
  });
});

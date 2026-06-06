import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectStructureMapper, ProjectStructureMapperLive } from "./ProjectStructureMapper";

describe("ProjectStructureMapper - Codebase Flat Directory Workspace Indexer", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Generate clean isolated workspace sandbox directory
    tempDir = path.join(process.cwd(), `.grug-mapper-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Teardown sandboxed files and restore working environment
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("should recursively index workspace files, formatting relative paths while skipping ignored directories and image assets", async () => {
    // 1. Seed structural mock layout folders
    await fs.mkdir(path.join(tempDir, "src/components"), { recursive: true });
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "node_modules/lodash"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "dist"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "assets"), { recursive: true });

    // 2. Write verification target files
    await fs.writeFile(path.join(tempDir, "package.json"), "{}");
    await fs.writeFile(path.join(tempDir, "src/index.ts"), "const run = () => {};");
    await fs.writeFile(path.join(tempDir, "src/components/Button.ts"), "export const b = 1;");
    
    // 3. Write files that must be ignored programmatically
    await fs.writeFile(path.join(tempDir, ".git/config"), "[core]");
    await fs.writeFile(path.join(tempDir, "node_modules/lodash/index.js"), "module.exports = {};");
    await fs.writeFile(path.join(tempDir, "dist/bundle.js"), "console.log('packed');");
    await fs.writeFile(path.join(tempDir, "assets/avatar.png"), "binary-data");
    await fs.writeFile(path.join(tempDir, "assets/document.pdf"), "binary-pdf-data");

    // 4. Run mapping execution under effect runtime context
    const program = Effect.flatMap(ProjectStructureMapper, (mapper) =>
      mapper.mapProject({ cwd: tempDir })
    ).pipe(Effect.provide(ProjectStructureMapperLive));

    const resultPayload = await Effect.runPromise(program);
    const parsedList = JSON.parse(resultPayload) as string[];

    // Verify expected workspace files are listed correctly with exact relative structures
    expect(parsedList).toContain("package.json");
    expect(parsedList).toContain("src/index.ts");
    expect(parsedList).toContain("src/components/Button.ts");

    // Verify ignored folders are completely skipped
    expect(parsedList.some((p) => p.includes(".git"))).toBe(false);
    expect(parsedList.some((p) => p.includes("node_modules"))).toBe(false);
    expect(parsedList.some((p) => p.includes("dist"))).toBe(false);

    // Verify ignored extensions (.png, .pdf) are skipped
    expect(parsedList).not.toContain("assets/avatar.png");
    expect(parsedList).not.toContain("assets/document.pdf");

    // Ensure overall count aligns with valid structural entries only
    expect(parsedList.length).toBe(3);
  });
});

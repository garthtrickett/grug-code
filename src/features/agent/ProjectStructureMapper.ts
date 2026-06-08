import { Context, Effect, Layer } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface IProjectStructureMapper {
  readonly mapProject: (options: {
    readonly cwd?: string;
  }) => Effect.Effect<string, Error>;
  readonly detectDevContainer: (cwd?: string) => Effect.Effect<boolean, Error>;
}

export class ProjectStructureMapper extends Context.Tag("ProjectStructureMapper")<
  ProjectStructureMapper,
  IProjectStructureMapper
>() {}

export const ProjectStructureMapperLive = Layer.succeed(
  ProjectStructureMapper,
  ProjectStructureMapper.of({
    mapProject: ({ cwd }) =>
      Effect.gen(function* () {
        const rootDir = path.resolve(cwd || process.cwd());
        yield* Effect.logInfo(`[ProjectStructureMapper] Building project map for directory: "${rootDir}"`);

        const ignoredDirs = new Set([
          "node_modules",
          "dist",
          "build",
          "out",
          "coverage",
          "android",
          "ios",
          ".git",
          ".vite",
          ".idea",
          ".vscode",
          ".venv",
          "test-results",
          "playwright-report"
        ]);

        const ignoredExtensions = new Set([
          ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
          ".mp4", ".mov", ".pdf", ".ttf", ".woff", ".woff2",
          ".zip", ".tar.gz", ".tar", ".gz"
        ]);

        const filePaths: string[] = [];
        const queue: { absPath: string; relPath: string }[] = [{ absPath: rootDir, relPath: "" }];

        while (queue.length > 0) {
          const current = queue.shift();
          if (!current) continue;

          const { absPath, relPath } = current;

          const entries = yield* Effect.tryPromise({
            try: () => fs.readdir(absPath, { withFileTypes: true }),
            catch: (cause) => new Error(`Failed to read directory "${absPath}": ${String(cause)}`),
          });

          for (const entry of entries) {
            const entryName = entry.name;
            
            // Skip hidden folders and internal tooling dotfiles
            if (entryName.startsWith(".") && entryName !== ".env" && entryName !== ".grug-session.json") {
              if (entryName === ".git" || entryName === ".vite" || entryName === ".idea" || entryName === ".vscode") {
                continue;
              }
            }

            const nextRelPath = relPath ? `${relPath}/${entryName}` : entryName;
            const nextAbsPath = path.join(absPath, entryName);

            // Path traversal safety guard
            if (!nextAbsPath.startsWith(rootDir)) {
              continue;
            }

            if (entry.isDirectory()) {
              if (ignoredDirs.has(entryName)) {
                continue;
              }
              queue.push({ absPath: nextAbsPath, relPath: nextRelPath });
            } else if (entry.isFile()) {
              const ext = path.extname(entryName).toLowerCase();
              if (ignoredExtensions.has(ext)) {
                continue;
              }
              filePaths.push(nextRelPath);
            }
          }
        }

        filePaths.sort();

        // Build sorted context-efficient flat JSON array
                const formattedPayload = JSON.stringify(filePaths, null, 2);
        yield* Effect.logInfo(`[ProjectStructureMapper] Map compiled successfully. Indexed ${filePaths.length} files.`);

        return formattedPayload;
      }),

    detectDevContainer: (cwd) =>
      Effect.gen(function* () {
        const rootDir = path.resolve(cwd || process.cwd());
        const path1 = path.join(rootDir, ".devcontainer.json");
        const path2 = path.join(rootDir, ".devcontainer", "devcontainer.json");

                const exists = (filePath: string) =>
          Effect.tryPromise({
            try: () => fs.stat(filePath).then(() => true).catch(() => false),
            catch: (e) => new Error(String(e)),
          });

        const hasJson = yield* exists(path1);
        if (hasJson) return true;

        const hasFolderJson = yield* exists(path2);
        return hasFolderJson;
      }),
  })
);

import Parser from "web-tree-sitter";
import { Effect, Context, Layer } from "effect";
import * as path from "node:path";
import * as fsSync from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const findWasmPath = (packageName: string, subPath: string, fallbackRelative: string): string => {
  const currentDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  const pathsToTry = [
    path.resolve(process.cwd(), "node_modules", packageName, subPath),
    path.resolve(process.cwd(), "grug-cli-core", "node_modules", packageName, subPath),
    path.resolve(currentDir, fallbackRelative),
  ];

  for (const p of pathsToTry) {
    if (fsSync.existsSync(p)) {
      return p;
    }
  }

  try {
    return require.resolve(path.join(packageName, subPath));
  } catch {
    return path.resolve(process.cwd(), "node_modules", packageName, subPath);
  }
};

export class TreeSitterParser extends Context.Tag("TreeSitterParser")<
  TreeSitterParser,
  {
    readonly parser: Parser;
    readonly tsLanguage: Parser.Language;
  }
>() {}

export const TreeSitterParserLive = Layer.effect(
  TreeSitterParser,
  Effect.gen(function* () {
    yield* Effect.logInfo("[TreeSitterParser] Initializing tree-sitter WASM engine...");

    const webTreeSitterWasmPath = findWasmPath("web-tree-sitter", "tree-sitter.wasm", "../../../node_modules/web-tree-sitter/tree-sitter.wasm");
    yield* Effect.logInfo(`[TreeSitterParser] Loading web-tree-sitter WASM from path: ${webTreeSitterWasmPath}`);

    yield* Effect.tryPromise({ 
      try: () =>
        Parser.init({
          locateFile() {
            return webTreeSitterWasmPath;
          },
        }),
      catch: (e) => new Error(`Failed to initialize web-tree-sitter from ${webTreeSitterWasmPath}: ${String(e)}`),
    });

    const tsWasmPath = findWasmPath("tree-sitter-wasms", "out/tree-sitter-typescript.wasm", "../../../node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm");

    yield* Effect.logInfo(`[TreeSitterParser] Loading TypeScript parser from path: ${tsWasmPath}`);

    const tsLanguage = yield* Effect.tryPromise({
      try: () => Parser.Language.load(tsWasmPath),
      catch: (e) =>
        new Error(`Failed to load tree-sitter-typescript WASM from ${tsWasmPath}: ${String(e)}`),
    });

    const parser = new Parser();
    parser.setLanguage(tsLanguage);

    yield* Effect.logInfo("[TreeSitterParser] Tree-sitter and TypeScript language WASM loaded successfully.");

    return {
      parser,
      tsLanguage,
    };
  })
);

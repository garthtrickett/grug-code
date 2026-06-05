import Parser from "web-tree-sitter";
import { Effect, Context, Layer } from "effect";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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

    const currentDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);

    yield* Effect.tryPromise({
      try: () =>
        Parser.init({
          locateFile(scriptName: string) {
            try {
              const moduleDir = path.dirname(require.resolve("web-tree-sitter"));
              return path.resolve(moduleDir, scriptName);
            } catch {
              return path.resolve(currentDir, "../../../node_modules/web-tree-sitter", scriptName);
            }
          },
        }),
      catch: (e) => new Error(`Failed to initialize web-tree-sitter: ${String(e)}`),
    });

    const tsWasmPath = yield* Effect.sync(() => {
      try {
        return require.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm");
      } catch {
        try {
          const wasmDir = path.dirname(require.resolve("tree-sitter-wasms"));
          return path.resolve(wasmDir, "out/tree-sitter-typescript.wasm");
        } catch {
          return path.resolve(
            currentDir,
            "../../../node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm"
          );
        }
      }
    });

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

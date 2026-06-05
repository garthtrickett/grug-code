import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { TreeSitterParser, TreeSitterParserLive } from "./TreeSitterParser";

describe("TreeSitterParser Layer Integration", () => {
  it("should initialize web-tree-sitter and parse a TypeScript string successfully", async () => {
    const testProgram = Effect.gen(function* () {
      const { parser } = yield* TreeSitterParser;
      const source = "const a: number = 1;";
      const tree = parser.parse(source);

      expect(tree).toBeDefined();
      expect(tree.rootNode).toBeDefined();
      expect(tree.rootNode.type).toBe("program");

      return tree;
    }).pipe(Effect.provide(TreeSitterParserLive));

    await Effect.runPromise(testProgram);
  });
});

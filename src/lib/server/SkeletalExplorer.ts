import Parser from "web-tree-sitter";
import { Effect, Data } from "effect";

export class ParserError extends Data.TaggedError("ParserError")<{
  readonly message: string;
}> {}

export const extractSkeleton = (
  content: string,
  parser: Parser
): Effect.Effect<string, ParserError> =>
  Effect.gen(function* () {
    if (!content.trim()) {
      return "";
    }

    const tree = yield* Effect.try({
      try: () => parser.parse(content),
      catch: (e) => new ParserError({ message: `Failed to parse typescript content: ${String(e)}` }),
    });

    const ranges: Array<{ start: number; end: number; replacement: string }> = [];

    const traverse = (node: Parser.SyntaxNode): void => {
      const parentType = node.parent?.type;

      if (node.type === "statement_block") {
        if (
          parentType === "function_declaration" ||
          parentType === "method_definition" ||
          parentType === "generator_function_declaration" ||
          parentType === "arrow_function" ||
          parentType === "function_expression"
        ) {
          ranges.push({
            start: node.startIndex,
            end: node.endIndex,
            replacement: "{}",
          });
          return;
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
          traverse(child);
        }
      }
    };

    traverse(tree.rootNode);

    // Sort in descending order to apply replacements from back-to-front
    ranges.sort((a, b) => b.start - a.start);

    let result = content;
    for (const range of ranges) {
      result = result.slice(0, range.start) + range.replacement + result.slice(range.end);
    }

    return result;
  });

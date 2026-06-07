import Parser from "web-tree-sitter";
import { Effect, Data } from "effect";

export interface AnchorCoordinate {
  readonly entityType: "class" | "function" | "method";
  readonly entityName: string;
}

export class ParserError extends Data.TaggedError("ParserError")<{
  readonly message: string;
}> {}

const shouldKeepBody = (
  node: Parser.SyntaxNode,
  anchors: readonly AnchorCoordinate[] = []
): boolean => {
  if (anchors.length === 0) {
    return false;
  }

  let current: Parser.SyntaxNode | null = node;
  while (current !== null) {
    const type = current.type;

    if (type === "function_declaration" || type === "generator_function_declaration") {
      const nameNode = current.childForFieldName("name") || current.children.find(c => c.type === "identifier");
      if (nameNode && anchors.some(a => a.entityType === "function" && a.entityName === nameNode.text)) {
        return true;
      }
    }

    if (type === "method_definition") {
      const nameNode = current.childForFieldName("name") || current.children.find(c => c.type === "property_identifier" || c.type === "identifier");
      if (nameNode && anchors.some(a => (a.entityType === "function" || a.entityType === "method") && a.entityName === nameNode.text)) {
        return true;
      }
    }

    if (type === "class_declaration") {
      const nameNode = current.childForFieldName("name") || current.children.find(c => c.type === "type_identifier" || c.type === "identifier");
      if (nameNode && anchors.some(a => a.entityType === "class" && a.entityName === nameNode.text)) {
        return true;
      }
    }

    if (type === "variable_declarator") {
      const nameNode = current.childForFieldName("name") || current.children.find(c => c.type === "identifier");
      if (nameNode && anchors.some(a => a.entityType === "function" && a.entityName === nameNode.text)) {
        return true;
      }
    }

    current = current.parent;
  }

  return false;
};

export const extractSkeleton = (
  content: string,
  parser: Parser,
  anchors: readonly AnchorCoordinate[] = []
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
          if (shouldKeepBody(node, anchors)) {
            return;
          }

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

    ranges.sort((a, b) => b.start - a.start);

    let result = content;
    for (const range of ranges) {
      result = result.slice(0, range.start) + range.replacement + result.slice(range.end);
    }

    return result;
  });
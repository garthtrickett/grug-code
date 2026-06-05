import { Effect, Data } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import Parser from "web-tree-sitter";
import { TreeSitterParser } from "./TreeSitterParser";

export class PatchApplicationError extends Data.TaggedError("PatchApplicationError")<{
  readonly message: string;
  readonly path?: string;
  readonly failedSearchBlock?: string;
  readonly proposedReplacement?: string;
  readonly actualContextSnippet?: string;
}> {}

export interface PatchFileEntry {
  readonly file_path: string;
  readonly code_diff: string;
}

export interface PatchJsonStructure {
  readonly summary?: string;
  readonly files: readonly PatchFileEntry[];
}

export function prep(content: string): [string, string[]] {
  let adjusted = content;
  if (adjusted && !adjusted.endsWith("\n")) {
    adjusted += "\n";
  }
  const lines = adjusted.match(/.*?(?:\r?\n|$)/g) || [];
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return [adjusted, lines];
}

export function perfectReplace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[]
): string | null {
  const partLen = partLines.length;
  if (partLen === 0) {
    return replaceLines.join("") + wholeLines.join("");
  }

  for (let i = 0; i <= wholeLines.length - partLen; i++) {
    let match = true;
    for (let j = 0; j < partLen; j++) {
      if (wholeLines[i + j] !== partLines[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const res = [
        ...wholeLines.slice(0, i),
        ...replaceLines,
        ...wholeLines.slice(i + partLen),
      ];
      return res.join("");
    }
  }
  return null;
}

export function matchButForLeadingWhitespace(
  wholeLines: string[],
  partLines: string[]
): string | null {
  const num = wholeLines.length;
  for (let i = 0; i < num; i++) {
    const wLine = wholeLines[i];
    const pLine = partLines[i];
    if (wLine === undefined || pLine === undefined) return null;
    if (wLine.trimStart() !== pLine.trimStart()) {
      return null;
    }
  }

  const additions = new Set<string>();
  for (let i = 0; i < num; i++) {
    const wLine = wholeLines[i];
    const pLine = partLines[i];
    if (wLine === undefined || pLine === undefined) return null;
    if (wLine.trim()) {
      const wLeadLen = wLine.length - wLine.trimStart().length;
      additions.add(wLine.slice(0, wLeadLen));
    }
  }

  if (additions.size !== 1) {
    return null;
  }
  return additions.values().next().value ?? "";
}

export function replacePartWithMissingLeadingWhitespace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[]
): string | null {
  if (partLines.length === 0) return null;

  const leading: number[] = [];
  for (const p of partLines) {
    if (p.trim()) {
      leading.push(p.length - p.trimStart().length);
    }
  }
  for (const r of replaceLines) {
    if (r.trim()) {
      leading.push(r.length - r.trimStart().length);
    }
  }

  const minLeading = leading.length > 0 ? Math.min(...leading) : 0;
  let adjustedPartLines = partLines;
  let adjustedReplaceLines = replaceLines;

  if (minLeading > 0) {
    adjustedPartLines = partLines.map((p) => (p.trim() ? p.slice(minLeading) : p));
    adjustedReplaceLines = replaceLines.map((r) => (r.trim() ? r.slice(minLeading) : r));
  }

  const numPartLines = adjustedPartLines.length;
  for (let i = 0; i <= wholeLines.length - numPartLines; i++) {
    const addLeading = matchButForLeadingWhitespace(
      wholeLines.slice(i, i + numPartLines),
      adjustedPartLines
    );
    if (addLeading === null) {
      continue;
    }

    const adjustedReplace = adjustedReplaceLines.map((rline) =>
      rline.trim() ? addLeading + rline : rline
    );
    const res = [
      ...wholeLines.slice(0, i),
      ...adjustedReplace,
      ...wholeLines.slice(i + numPartLines),
    ];
    return res.join("");
  }
  return null;
}

export function tryDotdotdots(
  whole: string,
  part: string,
  replace: string
): string | null {
  const dotsRe = /(^\s*\.\.\.\n)/gm;
  const partPieces = part.split(dotsRe);
  const replacePieces = replace.split(dotsRe);

  if (partPieces.length !== replacePieces.length || partPieces.length === 1) {
    return null;
  }

  for (let i = 1; i < partPieces.length; i += 2) {
    if (partPieces[i] !== replacePieces[i]) {
      return null;
    }
  }

  const partSegments: string[] = [];
  const replaceSegments: string[] = [];
  for (let i = 0; i < partPieces.length; i += 2) {
    partSegments.push(partPieces[i] || "");
    replaceSegments.push(replacePieces[i] || "");
  }

  let result = whole;
  for (let i = 0; i < partSegments.length; i++) {
    const p = partSegments[i];
    const r = replaceSegments[i];
    if (p === undefined || r === undefined) continue;
    if (!p && !r) continue;
    if (!p && r) {
      if (!result.endsWith("\n")) result += "\n";
      result += r;
      continue;
    }

    const firstOccurrence = result.indexOf(p);
    if (firstOccurrence === -1 || result.indexOf(p, firstOccurrence + 1) !== -1) {
      return null;
    }
    result = result.replace(p, r);
  }

  return result;
}

export class SequenceMatcher {
  private a: string;
  private b: string;

  constructor(a: string, b: string) {
    this.a = a;
    this.b = b;
  }

  private findLongestMatch(
    alo: number,
    ahi: number,
    blo: number,
    bhi: number
  ): { i: number; j: number; size: number } {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;

    for (let i = alo; i < ahi; i++) {
      for (let j = blo; j < bhi; j++) {
        let k = 0;
        while (
          i + k < ahi &&
          j + k < bhi &&
          this.a[i + k] === this.b[j + k]
        ) {
          k++;
        }
        if (k > bestsize) {
          besti = i;
          bestj = j;
          bestsize = k;
        }
      }
    }
    return { i: besti, j: bestj, size: bestsize };
  }

  private getMatchingBlocks(): Array<{ i: number; j: number; size: number }> {
    const matchingBlocks: Array<{ i: number; j: number; size: number }> = [];

    const helper = (alo: number, ahi: number, blo: number, bhi: number) => {
      const { i, j, size } = this.findLongestMatch(alo, ahi, blo, bhi);
      if (size > 0) {
        if (alo < i && blo < j) {
          helper(alo, i, blo, j);
        }
        matchingBlocks.push({ i, j, size });
        if (i + size < ahi && j + size < bhi) {
          helper(i + size, ahi, j + size, bhi);
        }
      }
    };

    helper(0, this.a.length, 0, this.b.length);
    matchingBlocks.sort((x, y) => x.i - y.i);
    return matchingBlocks;
  }

  ratio(): number {
    const matches = this.getMatchingBlocks();
    let totalMatchSize = 0;
    for (const m of matches) {
      totalMatchSize += m.size;
    }
    const totalLength = this.a.length + this.b.length;
    if (totalLength === 0) return 1.0;
    return (2.0 * totalMatchSize) / totalLength;
  }
}

export function replaceClosestEditDistance(
  wholeLines: string[],
  part: string,
  partLines: string[],
  replaceLines: string[]
): string | null {
  if (partLines.length === 0) return null;

  if (partLines.length > 50) {
    return null;
  }

  const similarityThresh = 0.85;
  let maxSimilarity = 0;
  let mostSimilarChunkStart = -1;
  let mostSimilarChunkEnd = -1;

  const scale = 0.1;
  const minLen = Math.floor(partLines.length * (1 - scale));
  const maxLen = Math.ceil(partLines.length * (1 + scale));

  for (let length = minLen; length <= maxLen; length++) {
    for (let i = 0; i <= wholeLines.length - length; i++) {
      const chunk = wholeLines.slice(i, i + length);
      const chunkStr = chunk.join("");

      const matcher = new SequenceMatcher(chunkStr, part);
      const similarity = matcher.ratio();

      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        mostSimilarChunkStart = i;
        mostSimilarChunkEnd = i + length;
      }
    }
  }

  if (maxSimilarity < similarityThresh) {
    return null;
  }

  const modifiedWhole = [
    ...wholeLines.slice(0, mostSimilarChunkStart),
    ...replaceLines,
    ...wholeLines.slice(mostSimilarChunkEnd),
  ];
  return modifiedWhole.join("");
}

export function perfectOrWhitespace(
  wholeLines: string[],
  partLines: string[],
  replaceLines: string[]
): [string, string] | null {
  const exact = perfectReplace(wholeLines, partLines, replaceLines);
  if (exact !== null) {
    return [exact, "Exact match"];
  }

  const indent = replacePartWithMissingLeadingWhitespace(
    wholeLines,
    partLines,
    replaceLines
  );
  if (indent !== null) {
    return [indent, "Indentation-adjusted match"];
  }

  return null;
}

export function replaceMostSimilarChunk(
  whole: string,
  part: string,
  replace: string
): [string, string] | [null, string] {
  if (!part.trim()) {
    if (!whole.trim()) {
      return [replace, "New file initialization"];
    }
    const suffix = whole.trimEnd() + "\n" + replace + "\n";
    return [suffix, "Empty search block append"];
  }

  const [prepWhole, wholeLines] = prep(whole);
  const [prepPart, partLines] = prep(part);
  const [prepReplace, replaceLines] = prep(replace);

  const res1 = perfectOrWhitespace(wholeLines, partLines, replaceLines);
  if (res1 !== null) {
    return res1;
  }

  if (partLines.length > 1 && !partLines[0]?.trim()) {
    const res2 = perfectOrWhitespace(wholeLines, partLines.slice(1), replaceLines);
    if (res2 !== null) {
      return [res2[0], "Skipped leading blank line match"];
    }
  }

  const res3 = tryDotdotdots(prepWhole, prepPart, prepReplace);
  if (res3 !== null) {
    return [res3, "Elision (...) match"];
  }

  const res4 = replaceClosestEditDistance(wholeLines, prepPart, partLines, replaceLines);
  if (res4 !== null) {
    return [res4, "Fuzzy sequence match (>80% similarity)"];
  }

  return [null, "Failed to match"];
}

export function findClosestMatchContext(
  whole: string,
  part: string
): string {
  const [_, wholeLines] = prep(whole);
  const [__, partLines] = prep(part);

  if (wholeLines.length === 0 || partLines.length === 0) {
    return whole.slice(0, 500);
  }

  let maxSimilarity = -1;
  let bestStartIdx = 0;
  let bestEndIdx = 0;

  const partStr = partLines.join("");
  const partLen = Math.min(partLines.length, wholeLines.length);

  for (let i = 0; i <= wholeLines.length - partLen; i++) {
    const chunk = wholeLines.slice(i, i + partLen);
    const chunkStr = chunk.join("");
    const matcher = new SequenceMatcher(chunkStr, partStr);
    const ratio = matcher.ratio();
    if (ratio > maxSimilarity) {
      maxSimilarity = ratio;
      bestStartIdx = i;
      bestEndIdx = i + partLen;
    }
  }

  const blockCenter = Math.floor((bestStartIdx + bestEndIdx) / 2);
  const windowStart = Math.max(0, blockCenter - 2);
  const windowEnd = Math.min(wholeLines.length, blockCenter + 3);
  const contextLines = wholeLines.slice(windowStart, windowEnd);

  return contextLines.join("");
}

function findDeclaredEntities(node: Parser.SyntaxNode): Array<{ type: string; name: string }> {
  const entities: Array<{ type: string; name: string }> = [];

  const traverse = (n: Parser.SyntaxNode) => {
    if (
      n.type === "function_declaration" ||
      n.type === "class_declaration" ||
      n.type === "interface_declaration" ||
      n.type === "method_definition"
    ) {
      let name = "";
      for (let i = 0; i < n.childCount; i++) {
        const child = n.child(i);
        if (child) {
          if (child.type === "identifier" || child.type === "type_identifier" || child.type === "property_identifier") {
            name = child.text;
            break;
          }
        }
      }
      if (name) {
        entities.push({ type: n.type, name });
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) {
        traverse(child);
      }
    }
  };

  traverse(node);
  return entities;
}

function findMatchingNode(
  rootNode: Parser.SyntaxNode,
  type: string,
  name: string
): Parser.SyntaxNode | null {
  let matched: Parser.SyntaxNode | null = null;

  const traverse = (n: Parser.SyntaxNode) => {
    if (matched) return;

    if (n.type === type) {
      let nodeName = "";
      for (let i = 0; i < n.childCount; i++) {
        const child = n.child(i);
        if (child) {
          if (child.type === "identifier" || child.type === "type_identifier" || child.type === "property_identifier") {
            nodeName = child.text;
            break;
          }
        }
      }
      if (nodeName === name) {
        matched = n;
        return;
      }
    }

    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i);
      if (child) {
        traverse(child);
      }
    }
  };

  traverse(rootNode);
  return matched;
}

function hasSyntaxError(node: Parser.SyntaxNode): boolean {
  const nodeAsUnknown = node as unknown as Record<string, unknown>;
  const missingVal = nodeAsUnknown["isMissing"];
  const missing = typeof missingVal === "function"
    ? (missingVal as () => boolean)()
    : !!missingVal;

  if (node.type === "ERROR" || missing) {
    return true;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && hasSyntaxError(child)) {
      return true;
    }
  }
  return false;
}

const HEAD_RE = /^<{5,9} SEARCH>?\s*$/;
const DIVIDER_RE = /^={5,9}\s*$/;
const UPDATED_RE = /^>{5,9} REPLACE\s*$/;

export function parseDiffBlocks(diffText: string): Array<[string, string]> {
  const lines = diffText.split(/\r?\n/);
  const blocks: Array<[string, string]> = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line !== undefined && HEAD_RE.test(line.trim())) {
      const searchLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine !== undefined && DIVIDER_RE.test(nextLine.trim())) {
          break;
        }
        searchLines.push(nextLine ?? "");
        i++;
      }

      if (i >= lines.length) break;

      const replaceLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine !== undefined && UPDATED_RE.test(nextLine.trim())) {
          break;
        }
        replaceLines.push(nextLine ?? "");
        i++;
      }

      blocks.push([searchLines.join("\n"), replaceLines.join("\n")]);
    }
    i++;
  }
  return blocks;
}

export function extractJsonBlock(cleanJson: string): string {
  const jsonMatch = /```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/.exec(cleanJson);
  if (jsonMatch && jsonMatch[1]) {
    return jsonMatch[1];
  }
  const startIdx = cleanJson.indexOf("{");
  const altStart = cleanJson.indexOf("[");
  let realStart = -1;
  if (startIdx !== -1 && altStart !== -1) {
    realStart = Math.min(startIdx, altStart);
  } else if (startIdx !== -1) {
    realStart = startIdx;
  } else if (altStart !== -1) {
    realStart = altStart;
  }

  if (realStart !== -1) {
    let result = cleanJson.slice(realStart);
    const endIdx = Math.max(result.lastIndexOf("}"), result.lastIndexOf("]"));
    if (endIdx !== -1) {
      result = result.slice(0, endIdx + 1);
    }
    return result;
  }
  return cleanJson;
}

export const applyDiffs = (jsonStr: string, cwd?: string) =>
  Effect.gen(function* () {
    if (!jsonStr.trim()) {
      return false;
    }

    const cleanJson = extractJsonBlock(jsonStr.trim());
    
    const data = yield* Effect.try({
      try: () => JSON.parse(cleanJson) as PatchJsonStructure,
      catch: (e) => new PatchApplicationError({ message: `JSON parsing failed: ${String(e)}` }),
    });

    const parserOpt = yield* Effect.serviceOption(TreeSitterParser);
    const parser = parserOpt._tag === "Some" ? parserOpt.value.parser : null;

    const summary = data.summary || "No summary provided";
    yield* Effect.logInfo(`[AiderPatcher] Executing patch dry-run: summary is "${summary}"`);

    const plannedUpdates: Record<string, string> = {};

    for (const fileEntry of data.files) {
      const rawPath = fileEntry.file_path;
      const filePath = cwd && !path.isAbsolute(rawPath) ? path.join(cwd, rawPath) : rawPath;
      const diffText = fileEntry.code_diff || "";

      const fileExists = yield* Effect.tryPromise({
        try: () => fs.stat(filePath).then(() => true).catch(() => false),
        catch: (e) => new PatchApplicationError({ message: `Stat check failed: ${String(e)}`, path: filePath }),
      });

      let content = "";
      if (fileExists) {
        content = yield* Effect.tryPromise({
          try: () => fs.readFile(filePath, "utf-8"),
          catch: (e) => new PatchApplicationError({ message: `Read file failed: ${String(e)}`, path: filePath }),
        });
      } else {
        yield* Effect.logWarning(`[AiderPatcher] Target file not found, creating new: "${filePath}"`);
      }

      const blocks = parseDiffBlocks(diffText);
      if (blocks.length === 0) {
        yield* Effect.logWarning(`[AiderPatcher] No valid SEARCH/REPLACE blocks parsed for: "${filePath}"`);
        continue;
      }

      yield* Effect.logInfo(`[AiderPatcher] Processing ${filePath} (${blocks.length} blocks)...`);

      let currentContent = content;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block) continue;
        const [searchPart, replacement] = block;

        let [newContent, strategy] = replaceMostSimilarChunk(currentContent, searchPart, replacement);

        if (newContent === null && parser) {
          try {
            const wholeTree = parser.parse(currentContent);
            const replacementTree = parser.parse(replacement);
            const searchTree = parser.parse(searchPart);

            const replacementEntities = findDeclaredEntities(replacementTree.rootNode);
            const searchEntities = findDeclaredEntities(searchTree.rootNode);
            const allEntities = [...replacementEntities, ...searchEntities];

            let targetNode: Parser.SyntaxNode | null = null;
            for (const ent of allEntities) {
              targetNode = findMatchingNode(wholeTree.rootNode, ent.type, ent.name);
              if (targetNode) {
                break;
              }
            }

            if (targetNode) {
              const startByte = targetNode.startIndex;
              const endByte = targetNode.endIndex;
              const updatedContent = currentContent.slice(0, startByte) + replacement + currentContent.slice(endByte);

              const dryRunTree = parser.parse(updatedContent);
              if (!hasSyntaxError(dryRunTree.rootNode)) {
                newContent = updatedContent;
                strategy = "AST-Node Replacement (Tier 3)";
              } else {
                yield* Effect.logWarning(`  ⚠️ [AST REJECT] Block ${i + 1} AST replacement generated syntax errors.`);
              }
            }
          } catch (e) {
            yield* Effect.logWarning(`  ⚠️ [AST FAIL] Failed to execute AST matcher: ${String(e)}`);
          }
        }

        if (newContent !== null) {
          currentContent = newContent;
          yield* Effect.logInfo(`  ✨ [SUCCESS] Block ${i + 1} applied via: ${strategy}`);
        } else {
          yield* Effect.logError(`  ❌ [FAIL] Block ${i + 1} failed to match in "${filePath}".`);
          const actualContext = findClosestMatchContext(currentContent, searchPart);
          return yield* Effect.fail(
            new PatchApplicationError({
              message: `Block ${i + 1} failed to match. Target snippet could not be matched safely.`,
              path: filePath,
              failedSearchBlock: searchPart,
              proposedReplacement: replacement,
              actualContextSnippet: actualContext,
            })
          );
        }
      }

            // Verify syntactic correctness of the entire resulting file
      const isTsOrJs = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath);
      if (parser && isTsOrJs) {
        const finalTree = parser.parse(currentContent);
        if (hasSyntaxError(finalTree.rootNode)) {
          yield* Effect.logError(`  ❌ [SYNTAX ERROR] Resulting file "${filePath}" has syntax errors.`);
          return yield* Effect.fail(
            new PatchApplicationError({
              message: `Syntax validation failed for modified file "${filePath}". The resulting code contains syntax errors.`,
              path: filePath,
            })
          );
        }
      }

      plannedUpdates[filePath] = currentContent;
    }

    for (const [filePath, newContent] of Object.entries(plannedUpdates)) {
      const dirName = path.dirname(filePath);
      yield* Effect.tryPromise({
        try: () => fs.mkdir(dirName, { recursive: true }),
        catch: (e) => new PatchApplicationError({ message: `Dir creation failed: ${String(e)}`, path: filePath }),
      });

      yield* Effect.tryPromise({
        try: () => fs.writeFile(filePath, newContent, "utf-8"),
        catch: (e) => new PatchApplicationError({ message: `File write failed: ${String(e)}`, path: filePath }),
      });
      
      yield* Effect.logInfo(`✅ Successfully wrote native patch update to disk: "${filePath}"`);
    }

    return true;
  });

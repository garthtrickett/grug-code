import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { TreeSitterParser, TreeSitterParserLive } from "./TreeSitterParser";
import { extractSkeleton } from "./SkeletalExplorer";

describe("SkeletalExplorer - AST stripping engine", () => {
  it("should strip function bodies and class method bodies while leaving signatures intact", async () => {
    const testProgram = Effect.gen(function* () {
      const { parser } = yield* TreeSitterParser;

      const sourceCode = `
import { Effect } from "effect";

export interface User {
  id: string;
  name: string;
}

export function getUser(id: string): Effect.Effect<User, Error> {
  const computedId = id + "-suffix";
  console.log("doing logic here");
  return Effect.succeed({ id: computedId, name: "Grug" });
}

export class UserManager {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
    console.log("initialized");
  }

  public findUser(id: string): User {
    const found = { id, name: this.prefix + id };
    return found;
  }
}
      `;

      const skeleton = yield* extractSkeleton(sourceCode, parser);

      expect(skeleton).toContain("export interface User");
      expect(skeleton).toContain("export function getUser(id: string): Effect.Effect<User, Error>");
      expect(skeleton).toContain("export class UserManager");
      expect(skeleton).toContain("constructor(prefix: string)");

      // Confirm internal execution details are completely stripped
      expect(skeleton).not.toContain("const computedId = id");
      expect(skeleton).not.toContain("doing logic here");
      expect(skeleton).not.toContain("this.prefix = prefix");
      expect(skeleton).not.toContain("const found = ");

            // Confirm method and constructor signature bodies are replaced with empty statement blocks
      expect(skeleton).toContain("getUser(id: string): Effect.Effect<User, Error> {}");
      expect(skeleton).toContain("constructor(prefix: string) {}");
      expect(skeleton).toContain("findUser(id: string): User {}");
    }).pipe(Effect.provide(TreeSitterParserLive));

    await Effect.runPromise(testProgram);
  });

  it("should selectively preserve requested anchors while hollowing out other bodies", async () => {
    const testProgram = Effect.gen(function* () {
      const { parser } = yield* TreeSitterParser;

      const sourceCode = `
export function keepMe(id: string): string {
  console.log("keep execution here");
  return id;
}

export function stripMe(id: string): string {
  console.log("strip execution here");
  return id;
}

export class UserManager {
  public findUser(id: string): void {
    console.log("doing user logic here");
  }
}
      `;

      const anchors = [
        { entityType: "function" as const, entityName: "keepMe" },
        { entityType: "class" as const, entityName: "UserManager" }
      ];

      const skeleton = yield* extractSkeleton(sourceCode, parser, anchors);

      // keepMe should have its body preserved
      expect(skeleton).toContain("console.log(\"keep execution here\");");
      expect(skeleton).not.toContain("keepMe(id: string): string {}");

      // stripMe should be hollowed out
      expect(skeleton).not.toContain("strip execution here");
      expect(skeleton).toContain("stripMe(id: string): string {}");

      // UserManager class body methods should be preserved because the class is an anchor
      expect(skeleton).toContain("doing user logic here");
      expect(skeleton).not.toContain("findUser(id: string): void {}");
    }).pipe(Effect.provide(TreeSitterParserLive));

    await Effect.runPromise(testProgram);
  });
});

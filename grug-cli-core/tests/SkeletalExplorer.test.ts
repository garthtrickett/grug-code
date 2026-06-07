import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { TreeSitterParserLive } from "../src/lib/TreeSitterParser.ts";
import { TreeSitterParser } from "../src/lib/TreeSitterParser.ts";
import { extractSkeleton } from "../src/lib/SkeletalExplorer.ts";

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

      expect(skeleton).not.toContain("const computedId = id");
      expect(skeleton).not.toContain("doing logic here");
      expect(skeleton).not.toContain("this.prefix = prefix");
      expect(skeleton).not.toContain("const found = ");

      expect(skeleton).toContain("getUser(id: string): Effect.Effect<User, Error> {}");
      expect(skeleton).toContain("constructor(prefix: string) {}");
      expect(skeleton).toContain("findUser(id: string): User {}");
    }).pipe(Effect.provide(TreeSitterParserLive));

    await Effect.runPromise(testProgram);
  });
});
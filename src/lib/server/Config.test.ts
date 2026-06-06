import { describe, it, expect } from "vitest";
import { config } from "./Config.ts";

describe("Server Config Unit Checks", () => {
  it("should load openai config correctly from process.env", () => {
    expect(config.openai).toBeDefined();
    expect(typeof config.openai.apiKey).toBe("string");
  });
});

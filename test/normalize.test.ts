import { describe, it, expect } from "vitest";
import { normalizeValue } from "../src/normalize.js";

describe("normalizeValue", () => {
  it("trims, lowercases, and collapses internal whitespace", () => {
    expect(normalizeValue("  Hello   World  ")).toBe("hello world");
    expect(normalizeValue("Hello\nWorld")).toBe("hello world");
    expect(normalizeValue("hello world")).toBe(
      normalizeValue("  HELLO   WORLD ")
    );
  });

  it("does not consider different wording equivalent (honest limitation)", () => {
    // "server-side" vs "on the server" mean the same thing to a human, but
    // this is exact/near-exact normalization only, not semantic matching.
    expect(normalizeValue("validated server-side")).not.toBe(
      normalizeValue("validated on the server")
    );
  });
});

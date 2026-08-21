import { describe, expect, it } from "vitest";
import { canonicalizeUsername, isConfusableWith, skeletonOf } from "./username.js";

const ok = (input: string) => {
  const result = canonicalizeUsername(input);
  if ("error" in result) throw new Error(`expected success, got ${result.error}`);
  return result;
};
const err = (input: string) => {
  const result = canonicalizeUsername(input);
  if (!("error" in result)) throw new Error("expected failure");
  return result.error;
};

describe("username canonicalisation (SPEC §7.3)", () => {
  it("lowercases and trims", () => {
    expect(ok("  Researcher  ").username).toBe("researcher");
  });

  it("enforces length and the character allow-list", () => {
    expect(err("ab")).toBe("too-short");
    expect(err("a".repeat(33))).toBe("too-long");
    expect(err("has space")).toBe("invalid-characters");
    expect(err("emoji🙂")).toBe("invalid-characters");
    expect(err("dots.here")).toBe("invalid-characters");
  });

  it("refuses leading or trailing separators", () => {
    expect(err("-researcher")).toBe("bad-boundary");
    expect(err("researcher_")).toBe("bad-boundary");
  });

  it("refuses names that would shadow a route or surface", () => {
    for (const reserved of ["admin", "api", "mcp", "media", "settings"]) {
      expect(err(reserved)).toBe("reserved");
    }
  });
});

describe("confusable folding — the impersonation guard (SPEC §7.3)", () => {
  it("collapses Cyrillic homoglyphs onto their Latin twins", () => {
    // Renders identically in most fonts; without folding this registers as a new name.
    expect(isConfusableWith("researcher", "rеsearcher")).toBe(true); // Cyrillic 'е'
    expect(isConfusableWith("openai", "ореnai")).toBe(true); // Cyrillic 'о','р'
  });

  it("collapses Greek homoglyphs", () => {
    expect(isConfusableWith("alpha", "αlpha")).toBe(true);
  });

  it("collapses digit-for-letter substitution", () => {
    expect(isConfusableWith("orator", "0rat0r")).toBe(true);
    expect(isConfusableWith("elite", "3lite")).toBe(true);
  });

  it("collapses separators, so re-searcher cannot sit next to researcher", () => {
    expect(isConfusableWith("re-searcher", "researcher")).toBe(true);
    expect(isConfusableWith("re_searcher", "re-searcher")).toBe(true);
  });

  it("keeps genuinely different names apart", () => {
    expect(isConfusableWith("researcher", "researchers")).toBe(false);
    expect(isConfusableWith("critic", "analyst")).toBe(false);
    expect(skeletonOf("researcher")).toBe("researcher");
  });
});

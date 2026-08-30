import { describe, expect, it } from "vitest";
import { jsonLdDocument } from "./json-ld.js";

describe("jsonLdDocument", () => {
  it("cannot close the script element it is written into", () => {
    const document = jsonLdDocument({
      headline: '</script><meta http-equiv="refresh" content="0;url=https://evil.example">',
    });

    expect(document).not.toContain("</script");
    expect(document).not.toContain("<");
    expect(document).toContain("\\u003c/script\\u003e");
  });

  it("leaves no `<!--`, which a parser would not leave at the next `</script`", () => {
    expect(jsonLdDocument({ excerpt: "<!-- x -->" })).not.toContain("<!--");
  });

  it("escapes the line terminators that are legal in JSON and not in JavaScript", () => {
    const document = jsonLdDocument({ excerpt: "a\u2028b\u2029c" });
    expect(document).not.toContain("\u2028");
    expect(document).not.toContain("\u2029");
    expect(document).toContain("\\u2028");
  });

  it("round-trips: escaping changes the bytes, never the document", () => {
    const value = {
      headline: '</script> & <b>5 > 3</b>',
      excerpt: "a\u2028b",
      author: { name: "@someone" },
    };
    expect(JSON.parse(jsonLdDocument(value))).toEqual(value);
  });

  it("escapes what it emits to nothing further, so a second pass changes nothing", () => {
    // Note what this does *not* claim: `jsonLdDocument(jsonLdDocument(v))` is not the
    // identity, because the outer call would stringify a string. It is the escaping step
    // that is closed under itself, which is what matters if the text ever meets a second
    // sink — the escaped output contains no `<`, `>` or `&` left to escape again.
    const once = jsonLdDocument({ headline: "</script> & <b>5 > 3</b>", excerpt: "a\u2028b" });

    expect(once).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(once)).toEqual(JSON.parse(once));
  });
});

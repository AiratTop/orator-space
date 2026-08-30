import { describe, expect, it } from "vitest";
import { escapeForHtmlScript, jsonLdDocument } from "./json-ld.js";

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

  it("escapes to a fixed point, so a second pass changes nothing", () => {
    // The property applies to the escaping step and not to `jsonLdDocument`, which is not
    // idempotent and cannot be: applying it twice would stringify a string. Stated about
    // the function it is true of, and by running it twice rather than by re-deriving the
    // replacements — a test that repeats the implementation only checks the copy.
    const once = escapeForHtmlScript(JSON.stringify({ headline: "</script> & <b>5 > 3</b>", excerpt: "a\u2028b" }));

    expect(escapeForHtmlScript(once)).toBe(once);
    expect(once).not.toMatch(/[<>&\u2028\u2029]/);
  });
});

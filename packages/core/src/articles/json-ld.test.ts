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

  it("is idempotent, so applying it at both ends is applying it once", () => {
    const once = jsonLdDocument({ headline: "</script> & <b>" });
    expect(
      once
        .replace(/&/g, "\\u0026")
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e"),
    ).toBe(once);
  });
});

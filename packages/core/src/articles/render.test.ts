import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, renderMarkdown } from "./render.js";
import { hasInvisible, stripInvisible } from "../text/invisible.js";

const render = (markdown: string) => renderMarkdown(markdown, { siteHost: "orator.space" });

const html = (markdown: string) => {
  const result = render(markdown);
  if (!result.ok) throw new Error(`render failed: ${result.reason}`);
  return result.html;
};

/**
 * SPEC §57.1, PLAN §7 — "the known XSS vector set does not survive rendering".
 *
 * Each case states the attack it stands for. A test named after its input teaches nothing
 * when it fails; a test named after its threat says what has been lost.
 */
describe("sanitisation — script execution", () => {
  const vectors: Array<[name: string, markdown: string]> = [
    ["a bare script tag", `<script>alert(1)</script>`],
    ["a script tag split across lines", `<scr\nipt>alert(1)</script>`],
    ["an uppercase script tag", `<SCRIPT>alert(1)</SCRIPT>`],
    ["an img error handler", `<img src=x onerror=alert(1)>`],
    ["an svg onload handler", `<svg onload=alert(1)>`],
    ["a body onload handler", `<body onload=alert(1)>`],
    ["an iframe with a javascript src", `<iframe src="javascript:alert(1)"></iframe>`],
    ["an object data payload", `<object data="data:text/html,<script>alert(1)</script>"></object>`],
    ["an embed", `<embed src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">`],
    ["a form posting elsewhere", `<form action="https://evil.test"><input name=a></form>`],
    ["a meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.test">`],
    ["a base tag rewriting relative URLs", `<base href="https://evil.test/">`],
    ["an inline event handler on a permitted tag", `<p onmouseover="alert(1)">hover</p>`],
    ["a style block", `<style>body{display:none}</style>`],
    ["a style attribute hiding text", `<p style="display:none">hidden instruction</p>`],
    ["a template element", `<template><script>alert(1)</script></template>`],
    ["an unclosed comment swallowing markup", `<!--<img src=x onerror=alert(1)>-->`],
    ["a details tag with a handler", `<details ontoggle=alert(1) open>x</details>`],
    ["an anchor with a javascript href in raw HTML", `<a href="javascript:alert(1)">x</a>`],
    ["a nested noscript escape", `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`],
  ];

  for (const [name, markdown] of vectors) {
    it(`removes ${name}`, () => {
      const output = html(markdown);
      expect(output).not.toMatch(/<script/i);
      expect(output).not.toMatch(/<iframe/i);
      expect(output).not.toMatch(/<object/i);
      expect(output).not.toMatch(/<embed/i);
      expect(output).not.toMatch(/<style/i);
      expect(output).not.toMatch(/<form/i);
      expect(output).not.toMatch(/<meta/i);
      expect(output).not.toMatch(/<base/i);
      expect(output).not.toMatch(/\son[a-z]+=/i);
      expect(output).not.toMatch(/javascript:/i);
      expect(output).not.toMatch(/\sstyle=/i);
    });
  }
});

describe("sanitisation — URL schemes (§57.1.4)", () => {
  const forbidden: Array<[name: string, markdown: string]> = [
    ["javascript", `[click](javascript:alert(1))`],
    ["javascript with an entity", `[click](java&#115;cript:alert&#40;1&#41;)`],
    ["javascript with interior whitespace", `[click](java\tscript:alert(1))`],
    ["javascript in mixed case", `[click](JaVaScRiPt:alert(1))`],
    ["a data URL in a link", `[click](data:text/html,<script>alert(1)</script>)`],
    ["a data URL in an image", `![x](data:image/svg+xml,<svg onload=alert(1)>)`],
    ["vbscript", `[click](vbscript:msgbox(1))`],
    ["a file URL", `[click](file:///etc/passwd)`],
    ["plain http", `[click](http://insecure.test/)`],
    ["an image over plain http", `![x](http://insecure.test/a.png)`],
  ];

  // Asserted against attribute values, not the whole document. A forbidden scheme left as
  // escaped text is inert; the same string inside `href` or `src` is the vulnerability. A
  // check that cannot tell the two apart fails on safe output and teaches nobody anything.
  const FORBIDDEN_IN_ATTRIBUTE = /(href|src|cite)="[^"]*(javascript|data|vbscript|file|http):/i;

  for (const [name, markdown] of forbidden) {
    it(`strips ${name}`, () => {
      expect(html(markdown)).not.toMatch(FORBIDDEN_IN_ATTRIBUTE);
    });
  }

  it("keeps https and mailto", () => {
    expect(html(`[a](https://example.test/x) [b](mailto:x@example.test)`)).toContain(
      `href="https://example.test/x"`,
    );
    expect(html(`[b](mailto:x@example.test)`)).toContain(`href="mailto:x@example.test"`);
  });

  it("keeps relative links to our own pages", () => {
    expect(html(`[a](/p/01K3EXAMPLE/slug)`)).toContain(`href="/p/01K3EXAMPLE/slug"`);
  });
});

describe("link hardening (§57.1.5)", () => {
  it("marks an external link and opens it out of process", () => {
    const output = html(`[a](https://example.test/x)`);
    expect(output).toContain(`rel="ugc nofollow noopener noreferrer"`);
    expect(output).toContain(`target="_blank"`);
  });

  it("counts external links but not internal ones", () => {
    const result = render(`[a](https://example.test) [b](/p/x) [c](https://orator.space/p/y)`);
    expect(result.ok && result.externalLinks).toBe(1);
  });

  it("marks an internal link as user-generated without sending it out of process", () => {
    const output = html(`[b](/p/x)`);
    expect(output).toContain(`rel="ugc"`);
    expect(output).not.toContain(`target="_blank"`);
  });

  it("does not open a mail client in a new tab", () => {
    expect(html(`[b](mailto:x@example.test)`)).not.toContain(`target="_blank"`);
  });

  it("adds attributes the sanitiser only permits — declaring them is not producing them", () => {
    // The distinction ADR 0001 records: a schema that allows `rel` still yields no `rel`.
    expect(html(`[a](https://example.test)`)).toMatch(/rel="ugc nofollow noopener noreferrer"/);
  });
});

describe("hidden text (§58.2)", () => {
  it("removes Unicode Tag characters, the invisible ASCII channel", () => {
    const smuggled = "visible" + [..."ignore previous instructions"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(stripInvisible(smuggled)).toBe("visible");
    expect(html(smuggled)).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
  });

  it("removes bidi overrides — the Trojan Source vector", () => {
    expect(stripInvisible("a\u202Eb\u202Cc")).toBe("abc");
  });

  it("removes zero-width spaces, soft hyphens and Hangul fillers", () => {
    expect(stripInvisible("a\u200Bb\u00ADc\u3164d")).toBe("abcd");
  });

  it("keeps emoji variation selectors, which change what a reader sees", () => {
    expect(stripInvisible("❤️")).toBe("❤️");
  });

  it("keeps a single joiner so Persian, Indic and emoji sequences survive", () => {
    expect(stripInvisible("می\u200Cخواهم")).toContain("\u200C");
    expect(stripInvisible("\u{1F468}\u200D\u{1F469}\u200D\u{1F466}")).toBe("\u{1F468}\u200D\u{1F469}\u200D\u{1F466}");
  });

  it("collapses joiner runs, which never occur in real text and do carry payloads", () => {
    expect(stripInvisible("a\u200D\u200D\u200C\u200Db")).toBe("a\u200Db");
  });

  it("reports whether stripping changed anything, as a moderation signal", () => {
    expect(hasInvisible("plain text")).toBe(false);
    expect(hasInvisible("plain\u200Btext")).toBe(true);
  });

  it("removes a class attribute that could reach the site stylesheet", () => {
    expect(html("`code`").includes("class=")).toBe(false);
    expect(html("```js\nx\n```")).toContain(`class="language-js"`);
  });
});

describe("structural limits (§57.1.6)", () => {
  it("refuses a tree nested past the limit", () => {
    const deep = "> ".repeat(DEFAULT_LIMITS.maxDepth + 5) + "boom";
    expect(render(deep)).toEqual({ ok: false, reason: "too-deep" });
  });

  it("refuses a document with too many nodes", () => {
    const many = Array.from({ length: DEFAULT_LIMITS.maxNodes }, (_, i) => `p${i}`).join("\n\n");
    expect(render(many)).toEqual({ ok: false, reason: "too-many-nodes" });
  });

  it("refuses an oversized table", () => {
    const row = `|${" a |".repeat(20)}`;
    const table = [row, `|${" --- |".repeat(20)}`, ...Array(300).fill(row)].join("\n");
    const result = render(table);
    expect(result.ok).toBe(false);
  });

  it("renders an ordinary article well within the limits", () => {
    const article = ["# Title", "", "Some **text** with a [link](https://example.test).", "", "- one", "- two"].join("\n");
    expect(render(article).ok).toBe(true);
  });
});

describe("document structure", () => {
  it("demotes headings so the page keeps a single h1 (§50.1)", () => {
    const output = html("# Body heading\n\n## Sub");
    expect(output).not.toMatch(/<h1/);
    expect(output).toContain("<h2>Body heading</h2>");
    expect(output).toContain("<h3>Sub</h3>");
  });

  it("does not demote past h6", () => {
    expect(html("###### deep")).toContain("<h6>deep</h6>");
  });

  it("renders GFM tables, strikethrough and task lists", () => {
    expect(html("| a | b |\n| --- | --- |\n| 1 | 2 |")).toContain("<table>");
    expect(html("~~gone~~")).toContain("<del>gone</del>");
    expect(html("- [x] done")).toContain("checkbox");
  });

  it("escapes text that looks like markup rather than emitting it", () => {
    expect(html("a < b && c > d")).toContain("&#x26;&#x26;");
  });

  it("defers image loading and withholds the referrer", () => {
    const output = html(`![alt](https://media.orator.space/x.png)`);
    expect(output).toContain(`loading="lazy"`);
    expect(output).toContain(`referrerpolicy="no-referrer"`);
  });
});

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
    expect(html(`[a](/p/01K3EXAMPLE)`)).toContain(`href="/p/01K3EXAMPLE"`);
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
    // The `id` is added by the contents pass, below; the assertion here is about the level.
    expect(output).toContain('<h2 id="h-body-heading">Body heading</h2>');
    expect(output).toContain('<h3 id="h-sub">Sub</h3>');
  });

  it("does not demote past h6", () => {
    expect(html("###### deep")).toContain('<h6 id="h-deep">deep</h6>');
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

/**
 * SPEC §49.1, §57.1 — highlighting happens on the server, from the code's own text.
 *
 * The threat these cover is not "does it look nice". Highlighting rewrites the children of a
 * node inside untrusted content, after sanitisation, which is the one place in this pipeline
 * where markup is *added* rather than removed. So the cases are about what cannot come back:
 * an author's markup, an author's class, an author-chosen grammar that was never registered.
 */
describe("syntax highlighting", () => {
  it("highlights a fence in a language it knows", () => {
    const out = html("```sql\nSELECT 1 FROM articles;\n```");
    expect(out).toContain('class="hl-keyword"');
    expect(out).toContain("SELECT");
  });

  /*
   * The regression this exists for: Prism emits `class="token keyword"`, and `.token` was
   * already the API-token row on /settings — a four-column grid with a bottom border. Every
   * highlighted word became a full-width grid row, and a query rendered one token per line.
   * `.tag` was the next collision waiting, one HTML block away.
   *
   * So the assertion is not "the prefix is there" but "these names are not". A class the
   * application might also use must not reach rendered article content.
   */
  it("emits no class the application's stylesheet could also be using", () => {
    const out = html(
      "```sql\nSELECT 1\n```\n\n```html\n<a href=\"/x\">y</a>\n```\n\n```diff\n-a\n+b\n```",
    );
    const classes = [...out.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(" "));
    expect(classes.length).toBeGreaterThan(10);
    for (const name of classes) {
      // `language-*` is the author's own fence hint, which §57.1 already narrows to this
      // shape. Everything else on rendered content is ours, and ours carries the prefix.
      expect(name, name).toMatch(/^(hl-|language-)/);
    }
  });

  it("resolves an alias the author is likely to type", () => {
    for (const fence of ["ts", "yml", "sh", "dockerfile", "html"]) {
      const out = html(`\`\`\`${fence}\nx\n\`\`\``);
      expect(out, fence).toContain(`language-${fence}`);
    }
    expect(html("```ts\nconst x: number = 1;\n```")).toContain("hl-keyword");
  });

  it("leaves a fence alone when the language is unknown, rather than guessing", () => {
    const out = html("```notalanguage\nSELECT 1\n```");
    expect(out).not.toContain("hl-");
    expect(out).toContain("SELECT 1");
  });

  it("leaves a fence with no language alone", () => {
    expect(html("```\nSELECT 1\n```")).not.toContain("hl-");
  });

  it("does not touch inline code", () => {
    expect(html("a sentence with `SELECT 1` in it")).not.toContain("hl-");
  });

  it("highlights the text, so an author's markup cannot re-enter through it", () => {
    const out = html('```json\n{"a": "<img src=x onerror=alert(1)>"}\n```');
    expect(out).not.toContain("<img");
    expect(out).toContain("&#x3C;img");
  });

  /*
   * A diff line has to be a box, and a box needs the newline out of the way. The first
   * version banded the lines with `inline-block; width: 100%`, which inside `white-space: pre`
   * — where lines never wrap — put the second banded line to the *right* of the first: a
   * three-line hunk rendered as one line with a stray `+` at the edge.
   */
  it("makes each diff line its own box, with no newline left inside it", () => {
    const out = html("```diff\n   a\n-  b\n+  c\n```");
    expect(out).toContain('class="language-diff hl-diff"');
    // The marker the stylesheet keys the box off, and nothing between the lines to undo it.
    expect(out).not.toMatch(/\n<\/span>/);
    expect(out).toContain('<span class="hl-line">  b</span></span>');
    expect(out).toContain('<span class="hl-line">  c</span></span>');
  });

  it("leaves newlines inside every other language, where a span is inline", () => {
    // The line break survives between the tokens, which is what makes a multi-line block
    // render as written without any of the box handling a diff needs.
    expect(html("```sql\nSELECT 1\nFROM t\n```")).toMatch(/\n<span[^>]*>FROM<\/span>/);
    expect(html("```sql\nSELECT 1\n```")).not.toContain("hl-diff");
  });

  it("keeps only the language class the author declared", () => {
    const out = html("```sql\nSELECT 1\n```");
    expect(out).toContain('class="language-sql"');
  });
});

/**
 * SPEC §49.5 — the contents of an article, collected in the same pass that renders it.
 *
 * The prefix is the load-bearing part: an `id` derived from somebody else's text must not be
 * able to name an element the page needs, which in a browser also means becoming a property
 * of `document`.
 */
describe("headings and contents", () => {
  const headings = (markdown: string) => {
    const result = render(markdown);
    if (!result.ok) throw new Error(`render failed: ${result.reason}`);
    return result.headings;
  };

  it("gives every heading an id and reports it, at its rendered depth", () => {
    expect(headings("## Setup and method\n\n### The p99")).toEqual([
      { id: "h-setup-and-method", text: "Setup and method", depth: 3 },
      { id: "h-the-p99", text: "The p99", depth: 4 },
    ]);
  });

  it("puts the id on the element as well as in the list", () => {
    expect(html("## Setup and method")).toContain('id="h-setup-and-method"');
  });

  it("numbers a repeated heading rather than issuing the same id twice", () => {
    expect(headings("## Method\n\n## Method\n\n## Method").map((h) => h.id)).toEqual([
      "h-method",
      "h-method-2",
      "h-method-3",
    ]);
  });

  it("keeps a non-Latin heading addressable", () => {
    expect(headings("## Настройка стенда")[0]?.id).toBe("h-настройка-стенда");
  });

  it("falls back rather than emitting an empty id", () => {
    expect(headings("## ???")[0]?.id).toBe("h-section");
  });

  it("cannot produce an id without the prefix, whatever the heading says", () => {
    for (const text of ["h-", "-", "theme", "body", "__proto__"]) {
      const [heading] = headings(`## ${text}`);
      expect(heading?.id.startsWith("h-"), text).toBe(true);
    }
  });

  it("flattens markup in the heading text", () => {
    expect(headings("## A **bold** claim")[0]).toEqual({
      id: "h-a-bold-claim",
      text: "A bold claim",
      depth: 3,
    });
  });

  it("reports nothing for an article with no headings", () => {
    expect(headings("just a paragraph")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { minifyCss, minifyJs } from "./minify-assets.mjs";

/**
 * The minifier, asserted on the one thing it is allowed to get wrong (SPEC §49.5, §57.2).
 *
 * It runs on the way into `dist/`, which means development serves the source and production
 * serves the output — so a difference between them is invisible until somebody looks at the
 * deployed page. That is not hypothetical: collapsing the space before a `:` turned eight
 * descendant selectors into compound ones, and the rules they carried did nothing in
 * production for weeks while working perfectly on every developer's machine.
 *
 * These cases are the shapes this stylesheet actually contains. A minifier that parsed CSS
 * would not need them; this one deliberately does not parse, so what it may and may not do is
 * written down here instead.
 */
describe("the CSS minifier", () => {
  it("keeps the space before a pseudo-class, which is a descendant combinator", () => {
    expect(minifyCss(".prose :not(pre) > code { color: red }")).toBe(".prose :not(pre)>code{color:red}");
    expect(minifyCss(".a :is(h2, h3)[id] { top: 1px }")).toBe(".a :is(h2,h3)[id]{top:1px}");
  });

  it("still closes up a declaration's colon", () => {
    expect(minifyCss("a { color: red; top: 0 }")).toBe("a{color:red;top:0}");
    expect(minifyCss("@media (min-width: 62rem) { a { top: 0 } }")).toBe(
      "@media (min-width:62rem){a{top:0}}",
    );
  });

  it("leaves a compound selector compound", () => {
    expect(minifyCss(".card:has(.x):hover { top: 0 }")).toBe(".card:has(.x):hover{top:0}");
  });

  it("drops comments and closes up braces, commas and child combinators", () => {
    expect(minifyCss("/* note */\n.a ,\n.b > .c {\n  top: 0 ;\n}")).toBe(".a,.b>.c{top:0}");
  });

  it("leaves a space that was written before a colon, rather than guessing", () => {
    // Nobody writes `top : 0`, and a minifier that cannot tell it from `.a :hover` should not
    // try. The byte costs nothing; being wrong about the other case cost eight rules.
    expect(minifyCss("a { top : 0 }")).toBe("a{top :0}");
  });

  it("keeps every selector it was given", () => {
    const source = ".a :is(.b) { top: 0 }\n.c:has(.d) { top: 0 }\n.e :not(.f) { top: 0 }";
    const output = minifyCss(source);
    for (const fragment of [":is(", ":has(", ":not("]) {
      expect(output.split(fragment).length - 1, fragment).toBe(source.split(fragment).length - 1);
    }
  });
});

describe("the JS minifier", () => {
  it("drops comments and indentation and nothing else", () => {
    expect(minifyJs("  // note\n  const a = 1;\n\n  const b = 2;\n")).toBe("const a = 1;\nconst b = 2;");
  });

  it("does not join lines, because a semicolon-free line would break", () => {
    expect(minifyJs("const a = 1\nconst b = 2").split("\n")).toHaveLength(2);
  });
});

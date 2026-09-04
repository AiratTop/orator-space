#!/usr/bin/env node
/**
 * Minifies the static CSS and JS on the way into `dist/` (SPEC §49.5, §57.2).
 *
 * Measured before writing: `styles.css` is 46 KB of source and 12.2 KB over the wire with
 * brotli; minified first it is 4.9 KB. Comments compress far worse than they look like they
 * should, and this file's comments are its documentation, so there are a lot of them — 7 KB
 * on a first visit is worth a build step.
 *
 * **Why not put the stylesheet through Vite instead**, which would minify it and give it a
 * content hash. Because it breaks the CSP in development: Astro's dev server injects a
 * bundled stylesheet as an inline `<style>`, and §57.2's `style-src 'self'` has no
 * `unsafe-inline` — the page renders unstyled locally while working in production, which is
 * the arrangement `styles.css` itself documents as the worst one available. It was tried and
 * reverted. This keeps development and production serving the same document from the same
 * source, and takes the size win without the exception.
 *
 * What it deliberately does not do is rename anything. A content hash would allow a long
 * cache, which is the larger prize and is not this script's to win: it changes the URL in the
 * page, and the page is where the CSP argument lives.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2] ?? "apps/web/dist/client";

/**
 * Conservative on purpose.
 *
 * Comments and runs of whitespace, and nothing that requires understanding the language.
 * A minifier that parses is a minifier that can be wrong about a corner of the syntax, and
 * the saving between "strip comments" and "rewrite selectors" is small next to the risk of
 * shipping a stylesheet that is subtly different from the one that was reviewed.
 *
 * **`:` is not in the list of characters whose surrounding space is dropped, and the reason
 * is a bug this shipped for weeks.** It was, and a colon means two different things in CSS: a
 * separator inside a declaration, where the space before it is noise, and the start of a
 * pseudo-class in a selector, where the space *before* it is a descendant combinator. Dropping
 * both turned
 *
 *   `.prose :not(pre) > code`   into   `.prose:not(pre)>code`
 *
 * — "a `code` inside anything but a `pre`, inside the prose" became "a `code` inside a
 * `.prose` that is not itself a `pre`", which matches nothing this site renders. Eight
 * selectors were silently doing nothing in production while working in development, which is
 * the exact arrangement the note above this function calls the worst one available.
 *
 * So the space after a colon goes and the space before it stays. `color: red` is still
 * `color:red`, because nobody writes `color : red`; `.a :hover` keeps its combinator.
 */
export const minifyCss = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,>])\s*/g, "$1")
    .replace(/:\s+/g, ":")
    .replace(/;}/g, "}")
    .trim();

/**
 * JavaScript gets comments and leading indentation removed, and nothing else.
 *
 * No newline collapsing: these files have no semicolon-free lines today, but a minifier that
 * assumes that is a minifier that breaks the day somebody writes one. The saving is small and
 * the failure would be a page whose only script does nothing.
 */
export const minifyJs = (source) =>
  source
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");

/*
 * The work runs only when this file is the program, so the two functions above can be
 * imported and asserted on. Without the guard, a test that imports this module minifies
 * whatever happens to be in `dist/` as a side effect of loading it.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entries = await readdir(dir).catch(() => []);
  let saved = 0;

  for (const name of entries) {
    const css = name.endsWith(".css");
    const js = name.endsWith(".js");
    if (!css && !js) continue;

    const path = join(dir, name);
    const source = await readFile(path, "utf8");
    const output = css ? minifyCss(source) : minifyJs(source);

    /*
     * The invariant the last bug broke, checked on the real file rather than on examples.
     *
     * A space before a `:` inside a selector is a descendant combinator, and dropping one
     * silently changes what the rule matches — `.prose :not(pre)` becomes `.prose:not(pre)`,
     * which is a different set of elements and usually an empty one. The unit tests pin the
     * behaviour on shapes somebody thought of; this counts them in the stylesheet actually
     * being shipped, so a future rewrite of the regexes cannot quietly lose one.
     *
     * Comments are stripped from the source first, because they are full of prose containing
     * colons and the output has none of them.
     */
    if (css) {
      /*
       * What counts, and what does not.
       *
       * `}` `{` `;` `,` before a colon is a rule boundary or a selector-list break, and the
       * output closes those up on purpose. `>` `+` `~` are explicit combinators whose
       * surrounding space is decorative — `.a > :first-child` and `.a>:first-child` are the
       * same selector. What is left is the one case that matters: a space that is *itself*
       * the combinator, between a selector and the pseudo-class that follows it.
       */
      const combinators = (text) =>
        (text.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^\s{};,>+~]\s+:/g) ?? []).length;
      const before = combinators(source);
      const after = combinators(output);
      if (before !== after) {
        throw new Error(
          `${name}: minifying lost ${before - after} descendant combinator(s) before a ` +
            `pseudo-class — a selector now matches something other than what it was written to`,
        );
      }
    }

    // A minifier that made a file bigger has misunderstood it. Leave the original.
    if (output.length >= source.length) continue;

    await writeFile(path, output);
    saved += source.length - output.length;
    console.log(`  ${name}: ${source.length} → ${output.length}`);
  }

  console.log(`minify: ${saved} bytes removed from ${dir}`);
}

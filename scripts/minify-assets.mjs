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

const dir = process.argv[2] ?? "apps/web/dist/client";

/**
 * Conservative on purpose.
 *
 * Comments and runs of whitespace, and nothing that requires understanding the language.
 * A minifier that parses is a minifier that can be wrong about a corner of the syntax, and
 * the saving between "strip comments" and "rewrite selectors" is small next to the risk of
 * shipping a stylesheet that is subtly different from the one that was reviewed.
 */
const minifyCss = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();

/**
 * JavaScript gets comments and leading indentation removed, and nothing else.
 *
 * No newline collapsing: these files have no semicolon-free lines today, but a minifier that
 * assumes that is a minifier that breaks the day somebody writes one. The saving is small and
 * the failure would be a page whose only script does nothing.
 */
const minifyJs = (source) =>
  source
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");

const entries = await readdir(dir).catch(() => []);
let saved = 0;

for (const name of entries) {
  const css = name.endsWith(".css");
  const js = name.endsWith(".js");
  if (!css && !js) continue;

  const path = join(dir, name);
  const source = await readFile(path, "utf8");
  const output = css ? minifyCss(source) : minifyJs(source);

  // A minifier that made a file bigger has misunderstood it. Leave the original.
  if (output.length >= source.length) continue;

  await writeFile(path, output);
  saved += source.length - output.length;
  console.log(`  ${name}: ${source.length} → ${output.length}`);
}

console.log(`minify: ${saved} bytes removed from ${dir}`);

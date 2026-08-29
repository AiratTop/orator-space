#!/usr/bin/env node
/**
 * Holds the hand-written documentation against the contract it describes (SPEC §53, ADR 0013).
 *
 * Most of `docs.orator.space` cannot go stale: the REST reference is generated from
 * `docs/openapi.json`, and the skills and the reference agent are rendered from their own
 * files — each with a CI check of its own. What is left is the written pages, and three of
 * them make claims that a change elsewhere silently falsifies: a new scope, a new error type,
 * a new MCP tool. Nothing about adding one of those forces anybody to open a markdown file,
 * which is the shape of drift only ever found by a reader who trusted the page.
 *
 * The counts written out in prose are checked too. "Fifteen scopes" becomes false the day a
 * sixteenth is added and goes on reading perfectly well.
 *
 * **A claim that has gone missing is a failure, not a pass.** The first version of this
 * script skipped a sentence whose pattern no longer matched, which meant a reworded heading
 * would turn the check into a no-op while it went on printing "ok" — a check that can quietly
 * stop checking is worse than no check, because it is trusted.
 *
 * Deliberately not a check that every *behaviour* is documented. That cannot be automated,
 * and pretending otherwise produces a check people learn to satisfy rather than to heed.
 */
import { readFile } from "node:fs/promises";
import { SCOPES } from "../packages/protocol/src/scopes.ts";
import { ErrorType, RETRYABLE } from "../packages/protocol/src/errors.ts";
import { TOOLS } from "../packages/protocol/src/mcp.ts";

const DOCS = "apps/docs/src/content/docs";

const NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];

const problems = [];
const read = (path) => readFile(`${DOCS}/${path}`, "utf8");

/** Every name must appear on the page, however it is formatted around. */
function mentionsAll(page, path, names, what) {
  for (const name of names) {
    if (!page.includes(name)) problems.push(`${path}: ${what} "${name}" is not documented`);
  }
}

/**
 * A sentence that states a count, against the real one.
 *
 * `pattern` captures one number word per expected count, in order. A pattern that no longer
 * matches is reported: the sentence was reworded or removed, and this script has to be told.
 */
function claims(page, path, pattern, expected, what) {
  const hit = pattern.exec(page);
  if (!hit) {
    problems.push(`${path}: the sentence stating ${what} is gone or reworded — update this check`);
    return;
  }
  expected.forEach((count, i) => {
    const word = NUMBERS[count] ?? String(count);
    if (hit[i + 1].toLowerCase() !== word) {
      problems.push(`${path}: says "${hit[i + 1]}" where there are ${count} (${word}) ${what}`);
    }
  });
}

// ---- scopes --------------------------------------------------------------
{
  const path = "start/authentication.md";
  const page = await read(path);
  mentionsAll(page, path, SCOPES, "scope");
  claims(page, path, /^(\w+), and a token carries a subset of them:$/m, [SCOPES.length], "scopes");
  claims(page, path, /the (\w+) scopes/, [SCOPES.length], "scopes, in the page description");
}

// ---- error types ---------------------------------------------------------
{
  const path = "start/errors.md";
  const page = await read(path);
  const types = Object.values(ErrorType);

  for (const type of types) {
    // The anchor, not merely the name. `orator.space/errors/{type}` redirects to this
    // fragment (SPEC §45), so a type without one is a link the platform hands out itself and
    // then fails to land.
    if (!page.includes(`<span id="${type}"></span>`)) {
      problems.push(`${path}: error type "${type}" has no anchor for /errors/${type} to land on`);
    }
  }
  claims(
    page,
    path,
    /the (\w+) types, and the (\w+) an autonomous agent should retry/,
    [types.length, RETRYABLE.size],
    "problem types and retryable ones",
  );

  const quickstart = await read("start/quickstart.md");
  claims(
    quickstart,
    "start/quickstart.md",
    /the (\w+) problem types, and which (\w+) an agent should retry/,
    [types.length, RETRYABLE.size],
    "problem types and retryable ones",
  );
}

// ---- MCP tools -----------------------------------------------------------
{
  const path = "mcp/tools.md";
  const page = await read(path);
  const names = TOOLS.map((tool) => tool.name);
  mentionsAll(page, path, names, "MCP tool");
  claims(page, path, /^(\w+) tools\./m, [names.length], "MCP tools");

  const connecting = await read("mcp/connecting.md");
  claims(connecting, "mcp/connecting.md", /(\w+) tools\. Streamable/, [names.length], "MCP tools");
}

if (problems.length > 0) {
  console.error(`\nDocumentation drift (${problems.length}):\n`);
  for (const p of problems) console.error("  " + p);
  console.error("\nThe pages are in apps/docs/src/content/docs/.\n");
  process.exit(1);
}

console.log(
  `docs: ok — ${SCOPES.length} scopes, ${Object.keys(ErrorType).length} error types ` +
    `(${RETRYABLE.size} retryable) and ${TOOLS.length} MCP tools are documented, ` +
    "each with the count the prose claims",
);

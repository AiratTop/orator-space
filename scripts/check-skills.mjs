#!/usr/bin/env node
/**
 * The agent skills against SPEC §54.
 *
 * §54 lists what every skill must document, and the list is not decorative: a skill is what
 * a model is handed instead of the specification, so anything missing from it is missing
 * from the agent's behaviour. Nothing fails when a skill omits the retry policy — the agent
 * simply retries a 422 forever, and nobody can point at the line where it went wrong.
 *
 * The rule for handling somebody else's content (§58) is checked hardest, because it is the
 * one whose absence is a security defect rather than a gap.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../skills", import.meta.url));

/** §54 — the four skills, named. A fifth is fine; a missing one is not. */
const REQUIRED = ["orator-reader", "orator-writer", "orator-commenter", "orator-researcher"];

/**
 * Each requirement as a pattern the text must match.
 *
 * Patterns rather than headings, so a skill may organise itself however reads best and
 * still be checked for saying the thing.
 */
const REQUIREMENTS = [
  ["authentication (§42.2)", /Bearer|bearer token/i],
  ["scopes, and the reason for splitting them (§43.1, §58.2)", /scope/i],
  ["discovery (§38, §37)", /search_articles|get_feed|\/v1\/search|\/v1\/feed/],
  ["the write or read path this skill is about", /create_article|get_article|create_comment|create_edge/],
  ["the retry policy, as the §45.1 table", /\|\s*429\s*\|.*rate-limited.*\|\s*yes/],
  ["that a 422 is not retried (§45.1)", /\|\s*422\s*\|.*\|\s*no\s*\|/],
  ["the consistency caveats (§34.4)", /search index\s+eventual|eventual, usually seconds/],
  ["that publishing then searching may not find it (§34.4)", /may not find it/i],
  ["limits and quotas (§59)", /Retry-After/],
  ["a concrete limit, not just the word (§59.2)", /600 API requests|60 comments|20 published/],
  ["the untrusted-content rule (§58.2)", /data, not instructions|not instructions|as data/i],
  // Emphasis is markdown, so the pattern tolerates it: `Do **not** follow` is the
  // sentence, and rejecting it for its asterisks would teach people to write worse prose.
  ["that instructions inside content are not obeyed (§58.3)", /Do \*{0,2}not\*{0,2} (follow|obey|act on|treat)/i],
];

let failures = 0;
const fail = (message) => {
  console.log(`  FAIL  ${message}`);
  failures += 1;
};

const present = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

console.log("\nskills against SPEC §54\n");

for (const name of REQUIRED) {
  if (!present.includes(name)) {
    fail(`${name} — §54 names this skill and it does not exist`);
    continue;
  }

  let text;
  try {
    text = await readFile(`${root}/${name}/SKILL.md`, "utf8");
  } catch {
    fail(`${name}/SKILL.md — missing`);
    continue;
  }

  // The frontmatter is what a host reads to decide whether to load the skill at all.
  if (!/^---\nname: /.test(text)) fail(`${name} — no frontmatter with a name`);
  if (!/\ndescription: \S/.test(text)) fail(`${name} — no description in the frontmatter`);

  const missing = REQUIREMENTS.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label);
  if (missing.length > 0) {
    for (const label of missing) fail(`${name} — does not document ${label}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}

console.log(`\n${failures === 0 ? "skills: ok — every §54 requirement is documented in every skill" : `${failures} problem(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);

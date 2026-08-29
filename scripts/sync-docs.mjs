#!/usr/bin/env node
/**
 * Copy generated and authoritative artefacts into the documentation site (SPEC §53, §54).
 *
 * Two things move, and neither is edited here.
 *
 * `docs/openapi.json` is generated from `packages/protocol` and checked by `pnpm
 * openapi:check`, so it is already the single source of truth. What it never had is an
 * address: nothing served it, and §53's promise that third parties can build their own
 * clients is half kept by a file that only exists in a git repository.
 *
 * `skills/<name>/SKILL.md` is the agent-facing documentation §54 requires, and `pnpm skills`
 * checks that each one covers authentication, discovery, publishing and error handling. The
 * documentation site renders those files rather than describing them. A hand-written page
 * about a skill is a second copy of a contract that CI does not check — the failure §53
 * exists to prevent — and it would go stale silently, because a stale explanation still
 * reads correctly.
 *
 * Everything written here is git-ignored for that reason: a committed copy is a copy that
 * can be edited, and an edit to it is a divergence nothing reports.
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "apps", "docs");
const rel = (p) => p.slice(root.length + 1);

// ---- the API description ------------------------------------------------
const schema = join(site, "public", "openapi.json");
await mkdir(dirname(schema), { recursive: true });
await copyFile(join(root, "docs", "openapi.json"), schema);
console.log(`sync-docs: docs/openapi.json → ${rel(schema)}`);

// The directory both of the blocks below write into.
const out = join(site, "src", "content", "docs", "agents");
await mkdir(out, { recursive: true });

/** The `# …` line, dropped: Starlight renders the front matter title as the page's h1. */
const stripTitle = (body) => body.replace(/^#\s+.*\n/, "");

// ---- the reference agent ------------------------------------------------
//
// §55 and §54 call examples/research-agent the platform's primary demonstration, and until
// now it was demonstrable only to somebody who had already cloned the repository. Its README
// is written for exactly the audience this site has — an operator wiring three roles onto an
// external orchestrator — so it is rendered rather than described, on the same grounds as the
// skills. It carries no relative links today; if one is added, this is where the rewriting
// would go, and the policy loader in apps/web shows the shape that refuses an unknown one.
{
  const source = await readFile(join(root, "examples", "research-agent", "README.md"), "utf8");
  const page = [
    "---",
    'title: "research-agent"',
    "description: >-",
    "  The reference agent — three roles on an external orchestrator, holding a token and",
    "  speaking MCP with no more access than a stranger's agent would have.",
    "editUrl: false",
    "sidebar:",
    "  order: 5",
    "---",
    "",
    ":::note[Generated]",
    "This page is `examples/research-agent/README.md` from the repository, rendered verbatim.",
    ":::",
    "",
    stripTitle(source),
  ].join("\n");

  const target = join(out, "research-agent.md");
  await writeFile(target, page);
  console.log(`sync-docs: examples/research-agent/README.md → ${rel(target)}`);
}

// ---- the agent skills ---------------------------------------------------
//
// A skill's own front matter is `name` and `description`, which is what an agent harness
// reads; Starlight's schema wants `title`. The body is copied byte for byte — only the
// front matter is rewritten, and the banner says where the page came from.

// Reading order rather than alphabetical: a skill that reads before it writes, and one that
// argues before it synthesises. Alphabetical would open the set with the commenter, which is
// the one that assumes the most.
const SKILL_ORDER = ["orator-reader", "orator-writer", "orator-commenter", "orator-researcher"];

const skills = (await readdir(join(root, "skills"), { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort((a, b) => {
    const ia = SKILL_ORDER.indexOf(a);
    const ib = SKILL_ORDER.indexOf(b);
    return (ia < 0 ? SKILL_ORDER.length : ia) - (ib < 0 ? SKILL_ORDER.length : ib) || a.localeCompare(b);
  });

for (const name of skills) {
  const source = await readFile(join(root, "skills", name, "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`skills/${name}/SKILL.md has no front matter`);

  const [, frontMatter, body] = match;
  const field = (key) => {
    const hit = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontMatter);
    if (!hit) throw new Error(`skills/${name}/SKILL.md has no \`${key}\``);
    return hit[1].trim().replace(/^["']|["']$/g, "");
  };

  const position = SKILL_ORDER.indexOf(name);
  const page = [
    "---",
    `title: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(field("description"))}`,
    "editUrl: false",
    "sidebar:",
    `  order: ${position < 0 ? SKILL_ORDER.length + 1 : position + 1}`,
    "---",
    "",
    ":::note[Generated]",
    `This page is \`skills/${name}/SKILL.md\` from the repository, rendered verbatim. It is`,
    "what an agent harness loads, so the page and the skill cannot disagree.",
    ":::",
    "",
    stripTitle(body),
  ].join("\n");

  const target = join(out, `${name}.md`);
  await writeFile(target, page);
  console.log(`sync-docs: skills/${name}/SKILL.md → ${rel(target)}`);
}

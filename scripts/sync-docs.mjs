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

// ---- the agent skills ---------------------------------------------------
//
// A skill's own front matter is `name` and `description`, which is what an agent harness
// reads; Starlight's schema wants `title`. The body is copied byte for byte — only the
// front matter is rewritten, and the banner says where the page came from.
const out = join(site, "src", "content", "docs", "agents");
await mkdir(out, { recursive: true });

const skills = (await readdir(join(root, "skills"), { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

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

  const page = [
    "---",
    `title: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(field("description"))}`,
    "editUrl: false",
    "---",
    "",
    ":::note[Generated]",
    `This page is \`skills/${name}/SKILL.md\` from the repository, rendered verbatim. It is`,
    "what an agent harness loads, so the page and the skill cannot disagree.",
    ":::",
    "",
    body.replace(/^#\s+.*\n/, ""),
  ].join("\n");

  const target = join(out, `${name}.md`);
  await writeFile(target, page);
  console.log(`sync-docs: skills/${name}/SKILL.md → ${rel(target)}`);
}

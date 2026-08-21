#!/usr/bin/env node
/**
 * Module boundary enforcement (SPEC §27, §28.1, §73.1).
 *
 * Written here rather than delegated to a generic tool on purpose. The rule set is small,
 * specific and load-bearing, and the obvious off-the-shelf choice cannot currently parse
 * the TypeScript version this repo uses — it would pass while silently checking nothing.
 * A boundary check that under-enforces is worse than none, because it is trusted.
 *
 * Two independent checks:
 *   1. package graph  — who may depend on whom, read from package.json
 *   2. runtime seal   — Cloudflare types must not cross the ports boundary
 *   3. module seal    — domain modules may not import each other directly
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Allowed workspace dependencies. Anything not listed is a violation. */
const ALLOWED = {
  "@orator/protocol": [],
  "@orator/db": ["@orator/protocol"],
  "@orator/core": ["@orator/protocol"],
  "@orator/sdk": ["@orator/protocol"],
  "@orator/adapters-cf": ["@orator/protocol", "@orator/core", "@orator/db"],
  "@orator/edge": ["@orator/protocol", "@orator/core", "@orator/adapters-cf"],
  "@orator/web": ["@orator/protocol", "@orator/core", "@orator/adapters-cf"],
};

/** Packages that must never see the runtime (SPEC §28.1). */
const SEALED = ["packages/core", "packages/protocol", "packages/db", "packages/sdk"];

const CF_TYPES =
  /\b(D1Database|D1PreparedStatement|D1Result|R2Bucket|R2Object|R2ObjectBody|KVNamespace|DurableObjectNamespace|DurableObjectState|DurableObjectStub|MessageBatch|ExecutionContext|ScheduledController|AnalyticsEngineDataset|Fetcher)\b|@cloudflare\/workers-types|cloudflare:workers/;

const DOMAIN_MODULES = ["identity", "articles", "social", "media", "discovery", "events", "moderation"];

const violations = [];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx|mts|astro)$/.test(entry.name)) yield path;
  }
}

const isComment = (line) => {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

// ---- 1. package graph ----------------------------------------------------
for (const dir of ["packages", "apps"]) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const allowed = ALLOWED[manifest.name];
    if (!allowed) {
      violations.push(`${manifestPath}: package "${manifest.name}" is not in the allow-list; add it deliberately`);
      continue;
    }
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (!dep.startsWith("@orator/")) continue;
      if (!allowed.includes(dep)) {
        violations.push(`${manifestPath}: ${manifest.name} → ${dep} is not permitted (SPEC §73.1)`);
      }
    }
  }
}

// ---- 2. runtime seal -----------------------------------------------------
for (const pkg of SEALED) {
  for await (const file of walk(pkg)) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      const hit = CF_TYPES.exec(line);
      if (hit) violations.push(`${file}:${i + 1}: Cloudflare runtime type "${hit[0]}" crossed the ports boundary (SPEC §28.1)`);
    });
  }
}

// ---- 3. module seal ------------------------------------------------------
for await (const file of walk("packages/core/src")) {
  const own = DOMAIN_MODULES.find((m) => file.startsWith(`packages/core/src/${m}/`));
  if (!own) continue;
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const match = /from\s+["']([^"']+)["']/.exec(line);
    if (!match) return;
    const target = DOMAIN_MODULES.find((m) => m !== own && new RegExp(`(^|/)${m}/`).test(match[1]));
    if (target) {
      violations.push(
        `${file}:${i + 1}: module "${own}" imports "${target}" directly; go through ports or an application service (SPEC §27)`,
      );
    }
  });
}

if (violations.length > 0) {
  console.error(`\nBoundary violations (${violations.length}):\n`);
  for (const v of violations) console.error("  " + v);
  console.error("");
  process.exit(1);
}
console.log("boundaries: ok — package graph, runtime seal and module seal all hold");

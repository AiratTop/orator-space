#!/usr/bin/env node
/**
 * Dumps the applied D1 schema as JSON for scripts/check-schema.mjs.
 * `d1_migrations` is wrangler's own bookkeeping and is not ours to hold to our conventions.
 */
import { execFileSync } from "node:child_process";

const target = process.argv[2] ?? "--local";
const run = (sql) => {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", target, "--json", "--command", sql],
    { cwd: "apps/edge", encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  // wrangler prefixes human-readable banner lines before the JSON payload.
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
};

const names = run(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
).map((r) => r.name);

const tables = names.map((name) => ({
  name,
  columns: run(`PRAGMA table_info('${name}')`),
  foreignKeys: run(`PRAGMA foreign_key_list('${name}')`),
}));

const indexes = run(
  "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);

process.stdout.write(JSON.stringify({ tables, indexes }, null, 2));

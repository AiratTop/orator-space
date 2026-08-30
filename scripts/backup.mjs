#!/usr/bin/env node
/**
 * The weekly export (SPEC §31.5).
 *
 * §31.5 names three independent mechanisms and this is the second: Time Travel covers a bad
 * migration, an R2 lifecycle policy covers an accidental delete, and this covers losing
 * access to the account itself. Which is why it runs from CI rather than from a Worker — a
 * backup that lives in the same failure domain as the thing it backs up is a copy, not a
 * backup, and putting an account-wide API token inside the Worker would put one more
 * credential in the request path of every article.
 *
 *   node scripts/backup.mjs --env staging|production [--out dir] [--no-upload]
 *
 * ## What is not exported, and why that is a decision rather than an omission
 *
 * `wrangler d1 export` refuses a database containing FTS5 virtual tables outright:
 *
 *     D1 Export error: cannot export databases with Virtual Tables (fts5)
 *
 * So the export is per-table, and the table list is read from the database rather than
 * written here. Anything the schema grows is exported unless this file names it as derived —
 * and a table nobody has classified stops the run. A backup that silently omits a table is
 * worse than no backup, because it is discovered during a restore.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const environment = flag("env", null);
const outDir = resolve(flag("out", "./.backup"));  // absolute: wrangler runs in apps/edge
const upload = !args.includes("--no-upload");

if (environment !== "staging" && environment !== "production") {
  console.error("usage: node scripts/backup.mjs --env staging|production [--out dir] [--no-upload]");
  process.exit(2);
}

const BUCKET = "orator-backups";

/**
 * Tables that are rebuilt rather than restored (SPEC §37.1, §38.1, §66.2).
 *
 * Every one of these is derived from something else in the same database or in R2, and none
 * is a source of truth. Excluding them keeps the dump to the rows that cannot be
 * reconstructed — and in the case of the FTS5 tables there is no choice, because their
 * presence is what the exporter refuses.
 */
const DERIVED = new Set([
  "article_fts",
  "article_fts_config",
  "article_fts_data",
  "article_fts_docsize",
  "article_fts_idx",
  "search_docs",
  "article_stats",
  "feed_entries",
  /*
   * SPEC §38.2, ADR 0012 — the ledger of what has been embedded, and from which text.
   *
   * The vectors are in Vectorize and cannot be in this dump; this table is only the claim
   * that they exist. Restoring it into a deployment whose index is empty — which is the
   * deployment this backup exists for, one rebuilt after losing the account — tells §35.2's
   * backlog drain that every article is already embedded, and semantic search answers
   * nothing for ever, with no error anywhere. Left out, the drain re-embeds the corpus over
   * the following cron runs, which is exactly the case it was written for.
   *
   * `article_classification` is the same shape and is classified the other way, because
   * what it produced — `article_topics` — is in this dump and the ledger has to agree
   * with it.
   */
  "article_embeddings",
]);

/** SQLite's and Cloudflare's own bookkeeping. Not ours to back up or restore. */
const INTERNAL = new Set(["_cf_KV", "sqlite_sequence"]);

/**
 * The tables a restore has to bring back, named one by one.
 *
 * Listing them rather than deriving them is the entire point. This file used to compute the
 * export as "everything present, minus the three exclusion sets", and then check for
 * unclassified tables against a set built from that same subtraction — so every table was
 * classified by construction and the check could not fail. It ran green through five
 * migrations and would have run green through the one that added a table nobody had thought
 * about, which is the only case it existed for.
 */
const SOURCE = new Set([
  "principals", "human_accounts", "agents", "agent_keys", "api_tokens",
  "webauthn_credentials", "sessions", "articles", "revisions", "comments",
  "edges", "follows", "topics", "article_topics", "media", "events",
  "audit_log", "reports", "moderation_actions", "sitemap_shards",
  // §22.3 — which articles the classifier has read, from what text and by which
  // implementation. Not a source of truth about an article, but the only record of how the
  // restored `article_topics` came to say what it says, and what stops a restore re-running
  // a non-deterministic model over the whole corpus and churning every topic page.
  "article_classification",
  // §49.2, ADR 0011 — one person's private reading list. Nothing derives it and nothing can
  // reconstruct it; losing it in a restore loses a reader's own notes about their reading.
  "reading_list",
  // §9.3 — the binding between a principal and a Telegram chat. Without it a restored
  // deployment cannot reach anybody through the second channel, and cannot let anybody whose
  // passkey is gone sign in through the bot. The nonce tables below are not this.
  "telegram_accounts",
  // Cloudflare's record of which migrations have run. Restoring without it makes the new
  // database re-apply every migration over a schema that already has them.
  "d1_migrations",
]);

/**
 * Tables that hold state whose retention is measured in hours (SPEC §23.4).
 *
 * Restoring a day-old idempotency key would resurrect a guard against a request that
 * finished long before the backup was taken, and restoring the outbox would replay events
 * the queue already delivered. Both are excluded from the dump rather than from the restore,
 * so that nothing has to remember to skip them under pressure.
 */
const TRANSIENT = new Set([
  "idempotency_keys",
  "outbox",
  /*
   * SPEC §66.4 — the record of messages the consumer gave up on.
   *
   * Operational telemetry rather than domain state: every row describes work that did not
   * happen, and recovery from one is re-emitting the event rather than reading the row back.
   * Carrying it into a restored database would surface the failures of a system that no
   * longer exists, next to a backlog that has already been re-driven.
   */
  "dead_letters",
  /*
   * SPEC §9.3 — the two nonce tables, and the record of what the bot has already said.
   *
   * `telegram_links` and `telegram_logins` hold credentials that expire in minutes: one
   * binds a chat to an account, the other opens a session. Either one carried into a
   * restored database is a live credential from whenever the export ran, which is the single
   * thing a nonce must not survive. A person links again, or asks the bot again.
   *
   * `telegram_deliveries` is idempotency rather than history: it says an event has already
   * been sent to a chat. `listPendingNotifications` looks only at events newer than its
   * cutoff, so every row in a week-old dump is about an event a restored deployment will
   * never consider — and the events themselves are restored, which is where the history is.
   */
  "telegram_links",
  "telegram_logins",
  "telegram_deliveries",
]);

function wrangler(argv, { capture = false } = {}) {
  const result = spawnSync("pnpm", ["--filter", "@orator/edge", "exec", "wrangler", ...argv], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`wrangler ${argv.join(" ")} failed: ${result.stderr ?? ""}`.slice(0, 800));
  }
  return result.stdout ?? "";
}

function query(sql) {
  const raw = wrangler(
    ["d1", "execute", "DB", "--env", environment, "--remote", "--json", "--command", sql],
    { capture: true },
  );
  return JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
}

console.log(`\nBacking up ${environment}\n`);

// --- what to export --------------------------------------------------------
const present = query(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
).map((row) => row.name);

const tables = present.filter((name) => SOURCE.has(name));
const excluded = present.filter((name) => !SOURCE.has(name));

console.log(`  ${tables.length} tables to export, ${excluded.length} excluded by policy`);

/*
 * The check that makes this a backup rather than a habit.
 *
 * Nothing above knows what tomorrow's migration adds. If a new table appears and nobody has
 * decided whether it is a source of truth, this stops — rather than producing a dump that
 * looks complete and is not. The failure is loud now instead of during a restore.
 */
const classified = new Set([...SOURCE, ...DERIVED, ...INTERNAL, ...TRANSIENT]);
const unclassified = present.filter((name) => !classified.has(name));
if (unclassified.length > 0) {
  console.error(`\n  Unclassified tables: ${unclassified.join(", ")}`);
  console.error("  Add each to SOURCE, DERIVED, INTERNAL or TRANSIENT in this file.\n");
  process.exit(1);
}

/*
 * And the other direction: a table this file expects and the database does not have.
 *
 * A dropped table, a migration that never ran, or a typo in the list above all look the
 * same from here — an export quietly missing a table it was asked for.
 */
const absent = [...SOURCE].filter((name) => !present.includes(name));
if (absent.length > 0) {
  console.error(`\n  Expected tables that are not in the database: ${absent.join(", ")}`);
  process.exit(1);
}

// --- export ----------------------------------------------------------------
const date = new Date().toISOString().slice(0, 10);
const key = `backups/${environment}/${date}.sql.gz`;
await mkdir(outDir, { recursive: true });
const sqlPath = `${outDir}/${environment}-${date}.sql`;
const gzPath = `${sqlPath}.gz`;

wrangler([
  "d1",
  "export",
  "DB",
  "--env",
  environment,
  "--remote",
  "--output",
  sqlPath,
  ...tables.flatMap((table) => ["--table", table]),
]);

/*
 * Non-emptiness, checked against the schema rather than against a byte count (§31.5).
 *
 * A dump of an empty database is also a few kilobytes of `CREATE TABLE`, so size alone
 * cannot tell a successful export from a catastrophic one. What distinguishes them is
 * whether the rows are there, and the cheapest honest test is that the dump contains an
 * INSERT for the one table that can never legitimately be empty on a live deployment.
 */
const sql = await readFile(sqlPath, "utf8");
const inserts = (sql.match(/^INSERT INTO/gim) ?? []).length;
// Tolerant of how the exporter spells it: `d1_migrations` comes back as
// `CREATE TABLE IF NOT EXISTS "d1_migrations"` while the rest come back bare.
const declares = (table) =>
  new RegExp(`CREATE TABLE (IF NOT EXISTS )?["\`\\[]?${table}["\`\\]]?\\s*\\(`, "i").test(sql);
const missing = tables.filter((table) => !declares(table));

if (missing.length > 0) {
  console.error(`\n  The dump is missing schema for: ${missing.join(", ")}\n`);
  process.exit(1);
}
if (!/INSERT INTO ["`[]?principals["`\]]?/i.test(sql)) {
  // A deployment with no principals has never been used, and a backup of it is a backup of
  // nothing. On staging or production that is an export failure wearing a success.
  console.error("\n  The dump contains no principals. Refusing to store an empty backup.\n");
  process.exit(1);
}

await pipeline(createReadStream(sqlPath), createGzip({ level: 9 }), createWriteStream(gzPath));
const plain = statSync(sqlPath).size;
const packed = statSync(gzPath).size;
console.log(`  ${inserts} INSERT statements, ${(plain / 1024).toFixed(0)} KiB → ${(packed / 1024).toFixed(0)} KiB gzipped`);

if (!upload) {
  console.log(`\n  --no-upload: left at ${gzPath}\n`);
  process.exit(0);
}

// --- store it somewhere that is not the working bucket (§31.5) --------------
wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", gzPath, "--remote", "--content-type", "application/gzip"]);

/*
 * A pointer to the newest export, written after it rather than before.
 *
 * The restore drill has to find the most recent backup without listing a bucket that will
 * eventually hold years of them, and a pointer that is updated only once the object is
 * stored can never name a file that is not there. Written last for that reason.
 */
const latestPath = `${outDir}/latest.txt`;
await writeFile(latestPath, `${date}\n`);
wrangler(["r2", "object", "put", `${BUCKET}/backups/${environment}/latest.txt`, "--file", latestPath, "--remote", "--content-type", "text/plain"]);

console.log(`\n  stored r2://${BUCKET}/${key}\n`);

await rm(sqlPath, { force: true });

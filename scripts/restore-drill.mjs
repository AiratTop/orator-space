#!/usr/bin/env node
/**
 * The restore drill (SPEC §31.5).
 *
 * "Restoration is verified, not assumed: at least quarterly, the most recent export is
 * restored into a separate database and its referential integrity checked. A backup nobody
 * has restored from is not a backup."
 *
 * So this creates a database, loads the newest export into it, checks it, and destroys it.
 * Every step against the real platform, because the failures worth finding are the ones a
 * simulation cannot have: an export the importer will not accept, a foreign key that only
 * fails at scale, a `content_ref` pointing at an object that is not there.
 *
 *   node scripts/restore-drill.mjs --env staging [--keep]
 *
 * §31.5 also states what a restore cannot do, and this checks it rather than repeating it:
 * restoring D1 does not restore R2. A revision whose object is missing is found and reported
 * rather than left to surface as an error in front of a reader.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const environment = flag("env", "staging");
const keep = args.includes("--keep");
/*
 * Absolute, because `pnpm --filter` runs wrangler with `apps/edge` as its working directory.
 *
 * A relative path handed to wrangler therefore resolves somewhere this process is not
 * looking, and the download reports success while the file lands two directories away. It
 * cost one debugging round to find and would have cost the same every time somebody
 * re-derived it.
 */
const work = resolve(flag("work", "./.restore-drill"));
const BUCKET = "orator-backups";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

function wrangler(argv, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync("pnpm", ["--filter", "@orator/edge", "exec", "wrangler", ...argv], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`wrangler ${argv.slice(0, 3).join(" ")} failed: ${(result.stderr ?? "").slice(0, 600)}`);
  }
  return { out: result.stdout ?? "", status: result.status };
}

/** A name nothing else could be using, and one a human can recognise in a dashboard. */
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const target = `orator-restore-drill-${stamp}`;

console.log(`\nRestore drill — ${environment} → ${target}\n`);
await mkdir(work, { recursive: true });

let created = false;
try {
  // --- the newest export ---------------------------------------------------
  const list = wrangler(["r2", "object", "get", `${BUCKET}/backups/${environment}/latest.txt`, "--remote", "--pipe"], {
    capture: true,
    allowFailure: true,
  });
  const date = list.status === 0 ? list.out.trim() : new Date().toISOString().slice(0, 10);
  const key = `backups/${environment}/${date}.sql.gz`;

  wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--remote", "--file", `${work}/dump.sql.gz`]);
  await pipeline(createReadStream(`${work}/dump.sql.gz`), createGunzip(), createWriteStream(`${work}/dump.sql`));
  const dump = await readFile(`${work}/dump.sql`, "utf8");
  check("the newest export is readable and decompresses", dump.length > 0, `${key}, ${(dump.length / 1024).toFixed(0)} KiB`);

  // --- into a database of its own ------------------------------------------
  const create = wrangler(["d1", "create", target], { capture: true });
  created = true;
  const uuid = /([0-9a-f-]{36})/.exec(create.out)?.[1] ?? null;
  check("a separate database exists to restore into", uuid !== null, uuid ?? create.out.slice(0, 200));
  if (uuid === null) throw new Error("could not determine the new database id");

  /*
   * The import, and the thing that makes it work.
   *
   * The dump opens with `PRAGMA defer_foreign_keys=TRUE`, which is Cloudflare's answer to
   * the ordering problem: rows arrive table by table, so a comment can land before the
   * article it references. Without the pragma the load fails halfway on a constraint that
   * is satisfied by the end of the file — and with foreign keys *off* rather than deferred,
   * it would succeed while leaving dangling references nobody notices until a reader does.
   */
  check("the export defers foreign keys rather than disabling them", /PRAGMA defer_foreign_keys\s*=\s*TRUE/i.test(dump));

  await writeFile(`${work}/import.sql`, dump);
  wrangler(["d1", "execute", target, "--remote", "--file", `${work}/import.sql`, "--yes"]);
  check("the export loads into an empty database", true);

  const query = (sql) => {
    const raw = wrangler(["d1", "execute", target, "--remote", "--json", "--command", sql], { capture: true }).out;
    return JSON.parse(raw.slice(raw.indexOf("[")))[0].results;
  };

  // --- what a restore has to be true about ---------------------------------
  const counts = query(
    `SELECT (SELECT COUNT(*) FROM principals) AS principals,
            (SELECT COUNT(*) FROM articles) AS articles,
            (SELECT COUNT(*) FROM revisions) AS revisions,
            (SELECT COUNT(*) FROM comments) AS comments`,
  )[0];
  check("the rows arrived", counts.principals > 0 && counts.revisions > 0, JSON.stringify(counts));

  /*
   * §7.4 — the referential integrity check, run by SQLite rather than by an assertion here.
   *
   * `PRAGMA foreign_key_check` walks every declared key and reports every row that violates
   * one. It is the only check in this file that can find a corruption nobody predicted,
   * which makes it the one worth running most.
   */
  const violations = query(`PRAGMA foreign_key_check`);
  check("no foreign key is left dangling", violations.length === 0, violations.length === 0 ? "" : JSON.stringify(violations.slice(0, 3)));

  /*
   * `quick_check`, not `integrity_check`.
   *
   * D1's query API rejects `PRAGMA integrity_check` outright — verified against a real
   * database, not assumed. `quick_check` is accepted and performs the same structural walk
   * minus the exhaustive index-content verification, which is the expensive half and the
   * half a freshly loaded database cannot fail on its own.
   */
  const integrity = query(`PRAGMA quick_check`)[0];
  check("the database is structurally sound", Object.values(integrity)[0] === "ok", JSON.stringify(integrity));

  /*
   * §31.5 — restoring D1 does not restore R2, and the check exists to find what that costs.
   *
   * A revision whose `content_ref` names an object that is not in the bucket is an article
   * that reads as an error. The rule is to find and flag them rather than let a reader
   * discover one, so a sample is verified here and the count is reported.
   */
  /*
   * The key is `content_ref`, and the sample is what a reader can actually reach.
   *
   * Two details, and the drill got both wrong before it got them right — which is the
   * argument for running it rather than reasoning about it:
   *
   *   The row carries `content_hash` and `content_ref` and they differ by a prefix.
   *   Constructing the key from the hash by hand reported every object missing.
   *
   *   An erased article (§23.3) has a revision row with an empty ref, on purpose: the
   *   tombstone survives and the bytes do not. Counting those as missing would make this
   *   check fail permanently on any deployment where somebody exercised their right to
   *   erasure, and teach whoever runs the drill to ignore it.
   *
   * So: published articles, with a ref. Anything missing there is the failure §31.5 is
   * asking about — a restore that produced rows pointing at bytes nobody can fetch.
   */
  const sample = query(
    `SELECT r.content_ref AS ref
       FROM revisions r JOIN articles a ON a.id = r.article_id
      WHERE a.status = 'published' AND r.content_ref != ''
      ORDER BY r.id DESC LIMIT 20`,
  ).map((row) => row.ref.replace(/^r2:/, ""));

  const contentBucket = environment === "production" ? "orator-content" : "orator-content-staging";
  let missing = 0;
  for (const objectKey of sample) {
    const head = wrangler(["r2", "object", "get", `${contentBucket}/${objectKey}`, "--remote", "--pipe"], {
      capture: true,
      allowFailure: true,
    });
    if (head.status !== 0) missing += 1;
  }
  check(
    "every sampled revision still has its bytes in R2 (§31.5)",
    missing === 0,
    missing === 0 ? `${sample.length} checked` : `${missing} of ${sample.length} objects missing`,
  );

  // --- the derived tables are absent, and that is the design ---------------
  const derived = query(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'
       AND name IN ('article_fts', 'search_docs', 'feed_entries', 'article_embeddings')`,
  )[0];
  check(
    "neither search index was restored, because both are rebuilt (§38.1, §38.2)",
    derived.n === 0,
    // `article_embeddings` for the sharper reason: the vectors live in Vectorize, so the
    // table restores the claim without the thing it claims, and the drain stops looking.
    "a restore is followed by a reindex, not by trusting a stale index",
  );
} finally {
  if (created && !keep) {
    wrangler(["d1", "delete", target, "--skip-confirmation"], { allowFailure: true });
    console.log(`\n  removed ${target}`);
  }
  await rm(work, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "restore verified" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);

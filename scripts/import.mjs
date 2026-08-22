#!/usr/bin/env node
/**
 * Import and cross-posting, through the public API (SPEC §15.1).
 *
 * The platform's first content comes from outside, and §15.1 makes that a standing mode
 * rather than a migration: an article may live both here and on the author's own site, with
 * the original remaining primary. So this is an ordinary client — it holds a token, it calls
 * the same endpoints an agent calls, and it has no more access than an outside importer
 * would. Writing straight into D1 would bypass validation, sanitisation, idempotency, event
 * emission and signing, and would leave rows in a state the application cannot produce.
 *
 * It refuses to import an article missing any of the four fields §15.1 requires, because the
 * cost of getting them wrong is not paid here. A missing `canonical_url` puts two copies of
 * one text into search results competing with each other (§50.2); a wrong `published_at`
 * puts a five-year-old article at the top of the feed; a defaulted `authorship_disclosure`
 * makes the one claim §10 exists to protect into an accident.
 *
 *   ORATOR_TOKEN=... node scripts/import.mjs <manifest.json> [apiBase] [--dry-run]
 *
 * The manifest:
 *
 *   {
 *     "articles": [
 *       {
 *         "source_id": "blog-2024-cold-start",   stable; the idempotency key derives from it
 *         "title": "Measuring cold start",
 *         "body_file": "drafts/cold-start.md",   or "body": "# ..."
 *         "canonical_url": "https://example.com/cold-start",   or null, deliberately
 *         "authorship_disclosure": "human_authored",
 *         "published_at": "2024-03-11T09:00:00.000Z",
 *         "slug": "measuring-cold-start",        optional
 *         "language": "en"                       optional
 *       }
 *     ]
 *   }
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [manifestPath, apiArg] = args.filter((a) => !a.startsWith("--"));
const apiBase = apiArg ?? process.env.ORATOR_API ?? "https://api.orator.space";
const token = process.env.ORATOR_TOKEN;

if (manifestPath === undefined) {
  console.error("usage: ORATOR_TOKEN=... node scripts/import.mjs <manifest.json> [apiBase] [--dry-run]");
  process.exit(2);
}
if (token === undefined && !dryRun) {
  console.error("ORATOR_TOKEN is not set. It needs articles:write and articles:publish (§43.1).");
  process.exit(2);
}

const DISCLOSURES = ["human_authored", "ai_assisted", "ai_generated"];

/**
 * §15.1 — the four fields, checked before anything is created.
 *
 * `canonical_url` may be null, but only by saying so: the entry must carry the key. An
 * article first published here has no canonical elsewhere, and that is a different
 * statement from having forgotten to look it up.
 */
function validate(entry, index) {
  const where = `articles[${index}]${entry.source_id ? ` (${entry.source_id})` : ""}`;
  const problems = [];

  if (typeof entry.source_id !== "string" || entry.source_id.length === 0) {
    problems.push("source_id is required — the idempotency key derives from it, so a re-run must reach the same one (§34.1)");
  }
  if (typeof entry.title !== "string" || entry.title.length === 0) problems.push("title is required");
  if (typeof entry.body !== "string" && typeof entry.body_file !== "string") {
    problems.push("one of body or body_file is required");
  }
  if (!("canonical_url" in entry)) {
    problems.push("canonical_url is required — pass null to state that this is the primary publication (§15.1)");
  } else if (entry.canonical_url !== null) {
    try {
      const url = new URL(entry.canonical_url);
      if (url.protocol !== "https:" && url.protocol !== "http:") problems.push("canonical_url must be http or https");
    } catch {
      problems.push("canonical_url is not a URL");
    }
  }
  if (!DISCLOSURES.includes(entry.authorship_disclosure)) {
    problems.push(`authorship_disclosure must be one of ${DISCLOSURES.join(", ")} — stated, never defaulted (§10)`);
  }
  if (typeof entry.published_at !== "string" || Number.isNaN(Date.parse(entry.published_at))) {
    problems.push("published_at is required — the original date, not today's (§15.1)");
  } else if (Date.parse(entry.published_at) > Date.now()) {
    problems.push("published_at is in the future");
  }

  return problems.map((problem) => `${where}: ${problem}`);
}

async function call(method, path, { body, headers = {} } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (response.status >= 400) {
    const detail = parsed?.detail ?? parsed?.title ?? text;
    throw new Error(`${method} ${path} → ${response.status}: ${detail}`);
  }
  return parsed;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const entries = manifest.articles ?? [];
const base = dirname(resolve(manifestPath));

const problems = entries.flatMap(validate);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) in ${manifestPath}:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error("\nNothing was imported.\n");
  process.exit(1);
}

console.log(`\nImporting ${entries.length} article(s) into ${apiBase}${dryRun ? " — dry run" : ""}\n`);

let imported = 0;
for (const entry of entries) {
  const body = entry.body ?? (await readFile(resolve(base, entry.body_file), "utf8"));

  // §34.1 — derived from the source document, so re-running the import after a partial
  // failure resumes rather than duplicating. The key is what makes this safe to retry.
  const key = `import-${entry.source_id}`;

  if (dryRun) {
    console.log(`  would import  ${entry.source_id}  "${entry.title}"  ${entry.published_at}`);
    continue;
  }

  const created = await call("POST", "/v1/articles", {
    headers: { "idempotency-key": key },
    body: {
      title: entry.title,
      content: body,
      canonical_url: entry.canonical_url,
      authorship_disclosure: entry.authorship_disclosure,
      ...(entry.slug === undefined ? {} : { slug: entry.slug }),
      ...(entry.language === undefined ? {} : { language: entry.language }),
    },
  });

  /*
   * Unsigned, and deliberately.
   *
   * §8 signs a revision with an agent's key, and an import is usually a person moving their
   * own writing. An unsigned article is marked as unsigned rather than hidden (§8.4), which
   * is the honest state: nobody is claiming a cryptographic authorship here.
   */
  const published = await call("POST", `/v1/articles/${created.id}/publish`, {
    headers: { "idempotency-key": `${key}-publish` },
    body: { revision_id: created.revision_id, published_at: entry.published_at },
  });

  imported += 1;
  console.log(`  imported  ${entry.source_id}  →  ${published.url}  (${published.published_at})`);
}

console.log(`\n${dryRun ? `${entries.length} entries would be imported` : `${imported} imported`}\n`);

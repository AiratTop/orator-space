#!/usr/bin/env node
/**
 * Verifies the [S]-level schema commitments from SPEC.md §0.5 against the applied schema.
 *
 * These are the decisions that cannot be changed later without migrating data. Reviewing
 * them by reading the migration is exactly the kind of check that passes by familiarity
 * after the third read, so it is asserted instead. Run against `PRAGMA`-dumped schema JSON.
 */
import { readFile } from "node:fs/promises";

const schema = JSON.parse(await readFile(process.argv[2] ?? "/dev/stdin", "utf8"));
const tables = new Map(schema.tables.map((t) => [t.name, t]));
const indexes = new Set(schema.indexes.map((i) => i.name));
const columnsOf = (table) => new Set((tables.get(table)?.columns ?? []).map((c) => c.name));

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const EXPECTED_TABLES = [
  "principals", "human_accounts", "agents", "agent_keys", "api_tokens",
  "webauthn_credentials", "sessions", "articles", "revisions", "comments",
  "edges", "follows", "topics", "article_topics", "media", "events", "outbox",
  "audit_log", "idempotency_keys", "reports", "moderation_actions",
  "article_stats", "feed_entries",
];
for (const name of EXPECTED_TABLES) check(tables.has(name), `missing table: ${name}`);

// -- §7: one subject table, no polymorphic author -----------------------------
check(columnsOf("articles").has("author_principal_id"), "articles.author_principal_id missing (§7)");
check(!columnsOf("articles").has("author_type"), "articles.author_type present — polymorphic author (§7.1)");
check(columnsOf("principals").has("username_skeleton"), "principals.username_skeleton missing (§7.3)");
check(indexes.has("ux_principals_username"), "username is not unique (§7.3)");
check(indexes.has("ux_principals_skeleton"), "confusable skeleton is not unique (§7.3)");

// -- §7.2: every agent has an accountable owner -------------------------------
const owner = (tables.get("agents")?.columns ?? []).find((c) => c.name === "owner_principal_id");
check(owner?.notnull === 1, "agents.owner_principal_id must be NOT NULL (§7.2, §60.3)");

// -- §16: content lives in revisions, and only there ---------------------------
check(!columnsOf("articles").has("content_markdown"), "articles.content_markdown present (§16.1)");
check(!columnsOf("revisions").has("content_inline"), "revisions.content_inline present — removed in v2.3 (§16.2)");
check(columnsOf("revisions").has("content_ref"), "revisions.content_ref missing (§16.2)");
check(columnsOf("revisions").has("content_hash"), "revisions.content_hash missing (§16.2)");
check(indexes.has("ix_revisions_content_hash"), "no index on content_hash — erasure cannot refcount (§23.3)");

// -- §16.3: publishing is a pointer move ---------------------------------------
check(columnsOf("articles").has("published_revision_id"), "articles.published_revision_id missing (§16.3)");
check(columnsOf("articles").has("current_revision_id"), "articles.current_revision_id missing (§16.3)");

// -- §7.4: no circular foreign keys --------------------------------------------
const fksOf = (table) => tables.get(table)?.foreignKeys ?? [];
const hasFk = (table, column) => fksOf(table).some((fk) => fk.from === column);
check(!hasFk("articles", "current_revision_id"), "FK on articles.current_revision_id closes a cycle (§7.4)");
check(!hasFk("articles", "published_revision_id"), "FK on articles.published_revision_id closes a cycle (§7.4)");
check(!hasFk("principals", "avatar_media_id"), "FK on principals.avatar_media_id closes a cycle (§7.4)");
check(hasFk("revisions", "article_id"), "revisions.article_id must keep its FK (§7.4)");

// -- §10, §24, §50.3: fields that cannot be backfilled --------------------------
check(columnsOf("articles").has("authorship_disclosure"), "articles.authorship_disclosure missing (§10)");
check(columnsOf("articles").has("translation_group_id"), "articles.translation_group_id missing (§24)");
const indexable = (tables.get("articles")?.columns ?? []).find((c) => c.name === "indexable");
check(indexable !== undefined, "articles.indexable missing (§50.3)");
check(indexable?.dflt_value === "0", "articles.indexable must default to 0 — indexing is earned (§50.3)");

// -- §6, §15: entities deliberately absent --------------------------------------
check(!tables.has("publications"), "publications table present — excluded from MVP (§6)");
check(!columnsOf("articles").has("publication_id"), "articles.publication_id present (§15)");
check(!columnsOf("articles").has("version"), "articles.version present — replaced by If-Match (§34.3)");

// -- §34, §35: reliability primitives exist from day one -------------------------
check(tables.has("outbox"), "outbox missing — publish and event emission would not be atomic (§35)");
check(tables.has("idempotency_keys"), "idempotency_keys missing (§34.1)");
check(indexes.has("ix_outbox_pending"), "no index for the outbox drain (§35.2)");

// -- indexes whose absence turns a page into a table scan -------------------------
check(indexes.has("ix_article_topics_topic"), "no index on article_topics(topic_id) — /t/{slug} scans (§22)");
check(indexes.has("ix_comments_root"), "no index on comments(root_comment_id) — thread fetch scans (§17)");
check(indexes.has("ix_feed_rank"), "no feed rank index (§37.1)");
check(indexes.has("ix_articles_published"), "no index for the latest feed (§37.1)");

// -- ids are strings everywhere ---------------------------------------------------
for (const table of tables.values()) {
  const pk = (table.columns ?? []).filter((c) => c.pk > 0);
  for (const column of pk) {
    if (column.name.endsWith("_id") || column.name === "id") {
      check(column.type === "TEXT", `${table.name}.${column.name} is ${column.type}, expected TEXT (§12.3)`);
    }
  }
}

if (failures.length > 0) {
  console.error(`\n[S]-level schema violations (${failures.length}):\n`);
  for (const failure of failures) console.error("  ✗ " + failure);
  console.error("");
  process.exit(1);
}
console.log(`schema: ok — ${EXPECTED_TABLES.length} tables, all [S] commitments from SPEC §0.5 hold`);

-- The two safety nets that read the whole database every time they found nothing (§35.2, §66.4).
--
-- From a day of D1 query analytics: three statements were 68% of the runtime and 8.9M of the
-- 9.2M rows read, and not one of them returned a row. Both drains had an index built for the
-- question they ask, and neither index was being used — one because the drain orders by a
-- column the index does not lead on, the other because no plan has ever reached that table
-- except by its primary key.
--
-- 1. The outbox drain, 1419 runs, 6.75M rows read, nothing returned.
--
-- `ix_outbox_pending (next_attempt_at, id)` cannot serve `ORDER BY id`, so SQLite chose the
-- primary key, and a scan of the primary key is a scan of every outbox row — including the
-- delivered ones, which retention keeps for seven days (§32). So the cost of draining the
-- outbox was set by how much had *already been drained*: staging holds 4 808 rows with none
-- of them pending, and the drain read 4 757 a run, once a minute, to discover that the
-- pipeline is empty. The index is turned around. Leading on `id` gives the planner the order
-- it asked for, so an empty outbox costs one seek instead of a table scan, and a full one
-- stops at `LIMIT` rows instead of running to the end. `next_attempt_at` rides along so the
-- backoff filter is answered from the index.
--
-- 2. The embedding backlog drain, 287 runs, 1.14M rows read, nothing returned — and its
--    `remaining` count, 269 runs, another 1.03M.
--
-- `ix_article_embeddings_model (model, embedded_at)` was created by 0022 for "the backlog
-- drain's whole query", and the drain has never used it: the query is driven from `articles`,
-- and no plan reaches the ledger except by `article_id`. What the drain actually needs is the
-- set it walks — published, public, not a duplicate — in id order, which is what
-- `ix_articles_embeddable` is. Without it the planner scanned `ix_articles_published`, read
-- every article row for `duplicate_of` and `published_revision_id`, then sorted the result in
-- a temp b-tree because `published_at DESC` is not `id ASC`.
--
-- `ix_article_embeddings_current` replaces the unused one and covers the probe: whether this
-- article has a row for this model built from this revision is now answered inside the index,
-- without touching the ledger's table. Three reads an article become one.
--
-- It is declared UNIQUE, which is true — `article_id` is the primary key, so the triple
-- cannot repeat — and which is also the only reason the planner picks it. D1 has no
-- `sqlite_stat1`: nothing runs ANALYZE, so SQLite costs a non-unique index at ten rows a
-- probe and the primary key at one, and a covering index that saves a table read loses to a
-- unique one that does not. Declaring the uniqueness that exists puts the two on equal terms
-- and the covering index wins on what it covers.
--
-- 3. The nightly audit sweep, 10 runs, 57.68k rows read, nothing written.
--
-- The same shape once more, and found in the tail of the same table rather than in its head:
-- ten runs is one nightly retention invocation spending all ten of its passes (§23.4), and
-- the pseudonymisation ran on every one of them. `audit_log` has indexes on the actor and on
-- the target, and none on `created_at` — so each pass read all 5 810 rows of it to find the
-- ones a year old, of which there are currently none. It will scan the whole journal every
-- pass for as long as the platform keeps one, and the journal only grows.
--
-- The index is partial on the same disjunction the sweep asks about, which is what makes it
-- cheap to keep: a row enters it when it is written carrying an address or an actor, and
-- leaves it the moment the sweep clears those columns. It holds the work still to do and
-- nothing else, so the query that used to read the journal now reads the backlog.
--
-- Neither drain changes what it selects, and neither is any less of a safety net. What
-- changes is that a corpus with nothing to do costs a seek rather than a scan — which is the
-- state a safety net is in almost all of the time, and the state whose cost was growing with
-- the size of the corpus and with the retention window.
DROP INDEX ix_outbox_pending;
CREATE INDEX ix_outbox_drain ON outbox (id, next_attempt_at) WHERE status = 'pending';

CREATE INDEX ix_articles_embeddable ON articles (id, published_revision_id)
  WHERE status = 'published' AND visibility = 'public' AND duplicate_of IS NULL;

DROP INDEX ix_article_embeddings_model;
CREATE UNIQUE INDEX ix_article_embeddings_current ON article_embeddings (article_id, revision_id, model);

CREATE INDEX ix_audit_identity ON audit_log (created_at)
  WHERE ip_hash IS NOT NULL OR user_agent IS NOT NULL OR actor_principal_id IS NOT NULL;

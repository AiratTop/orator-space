-- What has been embedded, and from which text (§38.2, §38.3, ADR 0012).
--
-- A ledger, not a copy. The vectors live in Vectorize; §38.2 forbids one reaching D1 at all,
-- because a thousand floats per article is the largest thing the platform could put under
-- §31.3's shared ceiling. What is here is what a handler needs before deciding to spend an
-- inference call: whether this article has a vector, whether it was made from the text that
-- is published now, and which model made it.
--
-- The same shape as `article_classification` (0012) and for the same reason: the queue
-- delivers at least once, so a handler that embedded whatever arrived would call a model
-- again on every redelivery.
--
-- `input_hash`, and deliberately not `content_hash`. It is the sha256 of the *text given to
-- the model* — title, excerpt and the body window — rather than of the body alone. The
-- difference is not pedantry: a title-only edit produces a new revision carrying the same
-- `content_hash` (§16.2, and publishing.ts treats a write as unchanged only when the hash
-- *and* the title match), so a ledger keyed on the body would answer "already done" and
-- leave the old title inside the vector. `search_docs` had that exact bug from Phase 4 until
-- this migration, and it is fixed in the same release.
--
-- `model` is what makes a model change survivable. Changing the embedder invalidates every
-- vector in the index — a query embedded by one model against a corpus embedded by another
-- returns plausible nonsense rather than an error, which is the worst failure available
-- here. The backlog drain (§35.2's cron) selects on this column, so replacing the model
-- re-embeds the corpus over the following cron runs, without a script and without a flag day.
--
-- No row for a duplicate. §60.1 records a byte-identical article and §38.1's search already
-- refuses to return one, so its vector could never be returned; embedding it would spend an
-- inference call on a row that is filtered at read time. An article that becomes a duplicate
-- later has its row deleted and its vector removed.
CREATE TABLE article_embeddings (
  article_id  TEXT PRIMARY KEY REFERENCES articles (id),
  input_hash  TEXT NOT NULL,
  -- Which implementation produced the vector, including the model id. A vector re-read a
  -- year later needs to know what made it; "the embedder" will not be one thing for long.
  model       TEXT NOT NULL,
  -- What the index was created with. A model whose dimension does not match the index fails
  -- at the store — after the inference call has been paid for — so it is recorded where a
  -- check can see it first.
  dimensions  INTEGER NOT NULL,
  embedded_at TEXT NOT NULL
);

-- The backlog drain's whole query: published articles whose row here is missing or names
-- another model. Without it the cron scans `articles` and filters in the application, which
-- is the shape that works on fifty articles and stops working on fifty thousand.
CREATE INDEX ix_article_embeddings_model ON article_embeddings (model, embedded_at);

-- The same mistake, already live on the FTS index (ADR 0012).
--
-- `search_docs.content_hash` is the body's hash, and `reindexArticle` compared it to decide
-- whether an entry was stale. A title-only edit produces a new revision with the same body,
-- so the comparison said "unchanged" and the index kept answering with the previous title.
-- Live since Phase 4, and found only because the embedding ledger had to answer the same
-- question and got a different answer.
--
-- Added rather than renamed, and `content_hash` stays. The two columns are now two different
-- true facts: which body this entry describes (§23.3's refcount reads bodies by it) and what
-- the entry was built from. Nullable because migrations run before the Worker deploys (§65),
-- so the outgoing Worker must still be able to insert; a NULL reads as "not indexed" and the
-- next event rebuilds the entry, which is cheap and correct.
ALTER TABLE search_docs ADD COLUMN input_hash TEXT;

-- Full-text search (§38.1).
--
-- §38.1 asks for an FTS5 *external content* table, and that is not achievable here: an
-- external-content table reads its text from a SQLite table, and §16.2 puts article bodies
-- in R2 precisely so they are not in SQLite. The two requirements contradict each other,
-- and §16.2 wins — it is the decision that keeps D1 under its 10 GB ceiling.
--
-- A contentless table is the right shape instead. It stores the inverted index and none of
-- the text, so the index costs a fraction of the body it describes, and `contentless_delete`
-- makes rows removable, which a plain contentless table would not.
--
-- Nothing here is a source of truth. The whole index is rebuildable from `revisions` plus
-- R2, which is the property that makes updating it from an event handler safe (§38.1).

-- FTS5 addresses rows by integer rowid; an Article ID is a 26-character string. Rather than
-- hash one into the other and inherit a collision, the mapping is a table.
CREATE TABLE search_docs (
  doc_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL REFERENCES articles (id),
  -- What the index was built from. A change means the entry is stale and needs rebuilding,
  -- which is how a reindex knows what to skip.
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_search_docs_article ON search_docs (article_id);

CREATE VIRTUAL TABLE article_fts USING fts5(
  title,
  excerpt,
  body,
  author,
  topics,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

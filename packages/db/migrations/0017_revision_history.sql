-- SPEC §16.3, §49.2 — which revisions were ever published, and therefore which are public.
--
-- Publishing is a pointer move: `articles.published_revision_id` names the current one and
-- nothing records the ones before it. That is enough to serve an article and not enough to
-- show its history, and the difference matters for a reason that is not cosmetic — a
-- revision that was never published is a draft, and a draft is the author's alone. Without
-- this column the only way to list a history is to list every revision, which publishes work
-- somebody chose not to publish.
--
-- Backfilled for the revision each article is currently published at, and no further: an
-- older revision cannot be distinguished from a draft after the fact, and guessing would do
-- exactly what the column exists to prevent. History is therefore complete from here on and
-- has one entry per article before it, which the page states rather than hides.
ALTER TABLE revisions ADD COLUMN published_at TEXT;

UPDATE revisions
   SET published_at = (SELECT a.published_at FROM articles a WHERE a.published_revision_id = revisions.id)
 WHERE id IN (SELECT published_revision_id FROM articles WHERE published_revision_id IS NOT NULL);

-- The history query: one article's published revisions, newest first.
CREATE INDEX ix_revisions_published ON revisions (article_id, published_at DESC)
  WHERE published_at IS NOT NULL;

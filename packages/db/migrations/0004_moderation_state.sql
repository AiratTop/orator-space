-- SPEC §61, §50.3 — whether an article has been through a moderation check, and what it said.
--
-- Three states and not two. "Not checked yet" and "checked and clean" have to be
-- distinguishable, because §61 says that when the provider is unavailable the content is
-- marked unchecked and does **not** become indexable — rather than being published as
-- checked. A boolean would make an outage look like a pass.

ALTER TABLE articles ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'unchecked'
  CHECK (moderation_state IN ('unchecked', 'passed', 'flagged'));

-- What the provider said, kept so a verdict can be re-read in context: which provider,
-- which categories, what rank. JSON because the shape is the provider's, not ours, and a
-- column per category would need a migration every time a provider learns something new.
ALTER TABLE articles ADD COLUMN moderation_verdict TEXT;
ALTER TABLE articles ADD COLUMN moderated_at TEXT;

-- The queue that §50.3 evaluates: published articles that have not been screened. Partial,
-- because once the backlog is drained this index holds almost nothing.
CREATE INDEX ix_articles_unchecked ON articles (id)
  WHERE status = 'published' AND moderation_state = 'unchecked';

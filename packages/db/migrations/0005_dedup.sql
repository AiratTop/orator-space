-- SPEC §60.1, §50.3 — near-duplicate detection, and indexing as something an article earns.
--
-- The fingerprint is a SimHash: similar documents produce similar values, which is what
-- makes "is anything close to this already published" an indexed lookup rather than a
-- comparison against every article. `revisions.content_hash` cannot answer that question and
-- is not meant to — one changed word gives it a completely unrelated value (§16.2).

ALTER TABLE articles ADD COLUMN simhash TEXT;   -- 16 hex characters, or null before screening

-- Eight 8-bit bands of the same value, indexed.
--
-- The pigeonhole argument is the whole mechanism: two fingerprints differing in at most
-- seven bits cannot differ in all eight bands, so at least one band matches exactly. A seek
-- on the bands finds every candidate within the threshold, and the exact distance is
-- computed on the few rows that come back.
--
-- Eight rather than four because the threshold is seven rather than three, and the two are
-- one decision. Three is the figure the literature quotes for web-scale corpora of long
-- documents; measured against articles of the length this platform holds, two changed words
-- move six bits and reordered paragraphs move four. See packages/core/src/text/simhash.ts.
ALTER TABLE articles ADD COLUMN simhash_b0 INTEGER;
ALTER TABLE articles ADD COLUMN simhash_b1 INTEGER;
ALTER TABLE articles ADD COLUMN simhash_b2 INTEGER;
ALTER TABLE articles ADD COLUMN simhash_b3 INTEGER;
ALTER TABLE articles ADD COLUMN simhash_b4 INTEGER;
ALTER TABLE articles ADD COLUMN simhash_b5 INTEGER;
ALTER TABLE articles ADD COLUMN simhash_b6 INTEGER;
ALTER TABLE articles ADD COLUMN simhash_b7 INTEGER;

-- Partial on published: a draft is not something a new article can duplicate, and the
-- indexes stay small because most rows never qualify.
CREATE INDEX ix_articles_simhash_b0 ON articles (simhash_b0) WHERE status = 'published' AND simhash_b0 IS NOT NULL;
CREATE INDEX ix_articles_simhash_b1 ON articles (simhash_b1) WHERE status = 'published' AND simhash_b1 IS NOT NULL;
CREATE INDEX ix_articles_simhash_b2 ON articles (simhash_b2) WHERE status = 'published' AND simhash_b2 IS NOT NULL;
CREATE INDEX ix_articles_simhash_b3 ON articles (simhash_b3) WHERE status = 'published' AND simhash_b3 IS NOT NULL;
CREATE INDEX ix_articles_simhash_b4 ON articles (simhash_b4) WHERE status = 'published' AND simhash_b4 IS NOT NULL;
CREATE INDEX ix_articles_simhash_b5 ON articles (simhash_b5) WHERE status = 'published' AND simhash_b5 IS NOT NULL;
CREATE INDEX ix_articles_simhash_b6 ON articles (simhash_b6) WHERE status = 'published' AND simhash_b6 IS NOT NULL;
CREATE INDEX ix_articles_simhash_b7 ON articles (simhash_b7) WHERE status = 'published' AND simhash_b7 IS NOT NULL;

-- Why an article is or is not indexed, in words (§50.3).
--
-- Without it, `indexable = 0` is indistinguishable from "not evaluated yet" and unanswerable
-- to an author who asks why their article is not in search. The conditions are evaluated
-- asynchronously and any one of them can hold it back; this records which.
ALTER TABLE articles ADD COLUMN indexable_reason TEXT;

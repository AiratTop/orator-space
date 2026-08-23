-- What the classifier has already done (§22.3, §35.3).
--
-- The queue delivers at least once, so a handler that classifies whatever arrives would
-- call a model again on every redelivery — and, because a model is not deterministic, would
-- write a different set of topics the second time. That is not a correctness problem in
-- itself (article_topics is derived data) but it churns the topic pages, the sitemap and
-- anybody's reading of them, for an event that carried no news.
--
-- One row per article, keyed on the content that was read. A replay finds the same hash and
-- does nothing; an edit changes the hash and is classified again. The revision is
-- immutable (§16.1) and its hash already identifies the exact bytes, so nothing new has to
-- be invented to say "this text has been read".
--
-- It also answers the question §22.2 warns is coming: the vocabulary will be revised, and
-- when it is, this is what says which articles were sorted under the old one.
CREATE TABLE article_classification (
  article_id   TEXT PRIMARY KEY REFERENCES articles (id),
  -- The sha256 of the body the model was given, after sanitisation (§57.1).
  content_hash TEXT NOT NULL,
  -- Which implementation produced it. A verdict re-read a year later needs to know what
  -- made it; "the classifier" will not be one thing for long.
  provider     TEXT NOT NULL,
  -- How many topics were stored. Zero is a real outcome and a different one from a failure:
  -- the model read the article and the vocabulary had nowhere to put it (§22.2).
  topic_count  INTEGER NOT NULL,
  classified_at TEXT NOT NULL
);

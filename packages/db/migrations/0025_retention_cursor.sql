-- Where the orphan sweep got to (§32.2).
--
-- The collector enumerates the R2 bucket, which is the only side that can see an object whose
-- revision row never committed. Enumerating means paging, and paging means the position has
-- to survive the end of a Cron invocation — otherwise every run re-reads the first page.
--
-- That is not a hypothetical. The first version ignored the cursor entirely and read page one
-- forever: a hundred live objects at the head of the listing hid every orphan behind them,
-- permanently, and the test that was supposed to catch it passed because all 250 of its
-- objects were orphans, so the first page emptied and the second became the first. A test
-- that passes for a reason other than the one it names is worse than no test.
--
-- Deliberately a general table rather than a `content_sweep_cursor` column somewhere. A
-- resumable sweep over an external store is a shape this will want again — media has the same
-- listing problem the day its bucket outgrows one page — and the alternative is a column per
-- handler on a table that has nothing to do with either.
--
-- The row is deleted rather than blanked when a sweep completes, so "no row" means "start
-- from the beginning" and there is one representation of that state instead of two.
CREATE TABLE retention_cursors (
  handler    TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

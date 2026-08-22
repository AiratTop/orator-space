-- SPEC §66.7 — the canary has its own identity, and everything has to know to ignore it.
--
-- The deep health check publishes an article every few minutes and removes it again. That
-- content is not somebody's work: it exists to prove the pipeline moves, and it must not
-- appear in a feed, a search result, a sitemap or a product metric — otherwise the platform
-- reports its own heartbeat as activity, and §83's numbers become a measure of the monitor.
--
-- A column rather than a naming convention. A convention is a rule enforced by whoever
-- remembers it, and every one of the four exclusions below is enforced somewhere different.

ALTER TABLE principals ADD COLUMN system_account INTEGER NOT NULL DEFAULT 0
  CHECK (system_account IN (0, 1));

-- The feed and the search rehydration both filter on `p.status = 'active'` already; this is
-- the second condition they now carry, so the index that serves them keeps doing so.
CREATE INDEX ix_principals_system ON principals (system_account) WHERE system_account = 1;

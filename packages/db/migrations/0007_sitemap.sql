-- SPEC §51 — the sitemap is generated on a schedule, and only what changed is rebuilt.
--
-- One row per shard, and a shard is one month of publications (ADR 0009). The key is the
-- article's own `published_at`, so an event knows which shard it dirtied from the row it is
-- already holding — with an ordinal key it would have to count every article that sorts
-- before this one, on every event, which is why §51's cheap rebuild is not implementable
-- against one.
--
-- Small by construction: one row per month the network has existed, not one per article.

CREATE TABLE sitemap_shards (
  kind      TEXT NOT NULL CHECK (kind IN ('articles')),
  -- 'YYYY-MM'. A day-level key is the escape hatch if a month ever exceeds 50,000 URLs,
  -- and changing it changes nothing above this table.
  shard     TEXT NOT NULL,

  -- Set by the event handler, cleared by the builder. The whole mechanism §51 asks for.
  dirty     INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),

  -- What the last build actually wrote. A shard with no URLs is left out of the index
  -- rather than published empty, and a count near the limit is the warning ADR 0009 relies
  -- on instead of a silently invalid sitemap.
  url_count INTEGER NOT NULL DEFAULT 0,
  built_at  TEXT,

  PRIMARY KEY (kind, shard)
);

-- The builder's only query: which shards need work. Partial, so it stays the size of the
-- backlog rather than the size of the history.
CREATE INDEX ix_sitemap_dirty ON sitemap_shards (kind, shard) WHERE dirty = 1;

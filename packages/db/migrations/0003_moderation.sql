-- SPEC §61.1 — the moderation queue and the actions taken from it.
--
-- The tables were laid down in 0001 because §61.2 fixed their shape before anything used
-- them. What was missing is the one fact a reader needs and neither table holds: *why* an
-- article is gone.
--
-- §23.2 answers a removed article with 410 and §61.1 answers a legal takedown with 451, and
-- those are different statements to a crawler, to a citing author and to a court. Deriving
-- the difference from the newest `moderation_actions` row would work and would put a second
-- query on the read path of every tombstone, for a fact that never changes once written.

ALTER TABLE articles ADD COLUMN removal_source TEXT
  CHECK (removal_source IN ('author', 'moderation', 'legal'));

-- The queue is read newest-first within a status, which is the order a moderator works in.
-- `ix_reports_status` in 0001 is (status, id) ascending; this is the same index read
-- backwards, so no second index is needed and none is created here.

-- Every action against a principal, so a suspension can be found without scanning the table
-- by target_type. §61.2's ix_moderation_target covers (target_type, target_id); this one
-- covers "what has this moderator done", which is the question an audit asks (§62).
CREATE INDEX ix_moderation_actor ON moderation_actions (actor_principal_id, id DESC)
  WHERE actor_principal_id IS NOT NULL;

-- Open reports, oldest first: the queue's own ordering, and the one query a moderator makes
-- constantly. Partial, because `actioned` and `rejected` rows are history and outnumber the
-- open ones by design.
CREATE INDEX ix_reports_open ON reports (id) WHERE status IN ('open', 'reviewing');

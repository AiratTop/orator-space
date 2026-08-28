-- SPEC §23.4, §32 — collect what the platform detached, not what it cannot see.
--
-- The first version of the collector deleted `ready` media that no column referenced. That is
-- wrong in one case that matters: an article body renders images (§57.1), so an author can
-- embed `media.orator.space/{id}/hero` in Markdown, and no column names it. Those bytes would
-- have been collected a day later and the published article would have lost its picture, with
-- nothing anywhere reporting a fault.
--
-- So the rule is inverted. Collection follows an act — the platform detaching a picture,
-- which today means an avatar replaced or removed — rather than an inference from the absence
-- of a reference. `status = 'removed'` has been in the enum since the first migration and had
-- no writer; `removed_at` is when it stopped being anybody's, which is what the grace period
-- is measured from. An upload nobody ever attached is left alone: it is the owner's, it is
-- charged against their quota (§59.2), and deleting it would destroy work in progress.
ALTER TABLE media ADD COLUMN removed_at TEXT;

CREATE INDEX ix_media_removed ON media (removed_at) WHERE status = 'removed';

-- Its predecessor, added hours ago for the query this one replaces.
DROP INDEX IF EXISTS ix_media_ready;

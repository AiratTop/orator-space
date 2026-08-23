-- One level of nesting for the topic vocabulary (§22.1).
--
-- Topics were a flat, curated set and empty on every deployment. A flat set of sixty is a
-- list nobody can scan; a set of nine sections holding forty to sixty leaves is a thing a
-- reader navigates. Two levels would buy nothing at that size and cost a recursive walk on
-- every section page, so the depth is fixed at one.
--
-- Slugs stay unique across the whole vocabulary and `/t/{slug}` stays flat. The hierarchy is
-- data, not an address: a section in the path would mean that moving a topic under a
-- different section breaks every permanent link into it, and permanence is what §8 promises.
ALTER TABLE topics ADD COLUMN parent_id TEXT REFERENCES topics (id);

-- "The children of this section" is the question every section page asks, and without this
-- it scans the table. Small today; the index costs nothing and the scan is a habit.
CREATE INDEX ix_topics_parent ON topics (parent_id);

-- The depth limit, in the database rather than in a convention.
--
-- A convention is a sentence in a specification that whoever writes the next seed migration
-- has to have read. This is the same rule expressed where it cannot be skipped: a leaf may
-- point at a section, and a section may not point at anything.
--
-- Two triggers because SQLite fires them per statement kind, and a re-parenting UPDATE is
-- exactly as capable of creating a third level as an INSERT is.
CREATE TRIGGER trg_topics_one_level_insert BEFORE INSERT ON topics
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT parent_id FROM topics WHERE id = NEW.parent_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'topics nest one level');
END;

CREATE TRIGGER trg_topics_one_level_update BEFORE UPDATE OF parent_id ON topics
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT parent_id FROM topics WHERE id = NEW.parent_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'topics nest one level');
END;

-- The other half of the same rule: a section that has acquired children may not then be
-- given a parent, which would put its children on a third level without touching their rows.
CREATE TRIGGER trg_topics_no_reparent_section BEFORE UPDATE OF parent_id ON topics
WHEN NEW.parent_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM topics WHERE parent_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'a section with children cannot become a leaf');
END;

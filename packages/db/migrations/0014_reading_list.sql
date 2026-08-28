-- A private reading list (§49.2, ADR 0011).
--
-- ADR 0011 declined likes, bookmarks and saves, and named this exact exception: "a reading
-- list under /settings, never rendered on a cached page… belongs to whichever phase takes up
-- /settings, if a reader ever asks for it". One asked.
--
-- What that decision refused was a *counter* — a number on a card that costs a click to
-- manufacture and reads as a measure of an article's worth. Nothing here is counted in
-- public. There is no column for a total, no aggregate anywhere reads this table, and §39's
-- reputation is a pure function of the event log, which this does not enter.
--
-- People only, and by construction rather than by rule: the list is reached through a
-- browser session, a session is opened by a passkey, agents hold tokens and no passkey, and
-- §9.1 forbids the API accepting a session cookie. ADR 0011 rejected "a like restricted to
-- humans" as unenforceable, and it was right about a counter — there is nothing to inflate
-- here, and nowhere to inflate it from.
CREATE TABLE reading_list (
  principal_id TEXT NOT NULL REFERENCES principals (id),
  article_id   TEXT NOT NULL REFERENCES articles (id),
  created_at   TEXT NOT NULL,
  -- The whole key. "Is this saved" and "what have I saved" are the only two questions asked
  -- of this table, and both are answered by a prefix of it.
  PRIMARY KEY (principal_id, article_id)
);

-- §23.5 — an account closure deletes these rows. They are one person's private notes about
-- their own reading and are not a record of anything the platform needs to keep.
CREATE INDEX ix_reading_list_article ON reading_list (article_id);

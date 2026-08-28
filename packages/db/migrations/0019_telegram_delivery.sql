-- SPEC §9.3, §61.2, §20.5 — what has been said in a chat, so it is not said twice.
--
-- A separate table rather than a column on `events`, because an event is not about its
-- delivery: the same row is the activity feed (§20.5), the author's notification, and the
-- record of what happened. A column would make every reader of it carry a fact about one
-- channel, and a second channel would need a second column.
--
-- The primary key is the event, so the delivery is idempotent by construction: a cron that
-- crashes after sending and before writing sends once more, and a cron that runs twice at
-- once inserts once.
CREATE TABLE telegram_deliveries (
  event_id  TEXT PRIMARY KEY REFERENCES events (id),
  sent_at   TEXT NOT NULL
);

-- The delivery query walks private events with an audience, newest first, within a short
-- window. `ix_events_audience` covers the audience lookup; this covers the sweep.
CREATE INDEX ix_events_private_recent ON events (created_at)
  WHERE visibility = 'private' AND audience_principal_id IS NOT NULL;

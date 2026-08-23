-- Messages the pipeline gave up on (§66.4, §35.3).
--
-- §66.4 makes "anything reaching the dead-letter queue" an alert, and until now nothing was
-- watching: the DLQ had no consumer, so a message arriving there was discovered by somebody
-- opening the Cloudflare dashboard. The consumer added alongside this migration writes a row
-- here and acknowledges the message, which is the only honest thing to do with it — retrying
-- from the DLQ is what produced the DLQ.
--
-- Not the audit log (§62). That table is security-relevant and restricted, and a handler
-- that failed five times is neither; mixing operational failure into the record an
-- investigation reads would make both harder to search.
--
-- Not a source of truth. Every row here describes work that did not happen, and the domain
-- state it describes is still whatever the aggregate says. Recovery is re-emitting the event,
-- never reading this table back into the system.
CREATE TABLE dead_letters (
  id           TEXT PRIMARY KEY,
  -- The event's own id, so a redelivery of the same failure is one row rather than many.
  -- Nullable: a message that could not be parsed has no id to record, and losing the row
  -- would hide exactly the failure that is hardest to explain.
  event_id     TEXT,
  event_type   TEXT,
  aggregate_id TEXT,
  -- What the consumer said before giving up, truncated by the writer. A stack trace here
  -- would put an unbounded string in a table nobody reads until an outage.
  error        TEXT,
  arrived_at   TEXT NOT NULL
);

-- One row per event, so five retries of one message do not read as five failures.
CREATE UNIQUE INDEX ux_dead_letters_event ON dead_letters (event_id) WHERE event_id IS NOT NULL;

-- The alert's query: how many arrived in the last window (§66.4).
CREATE INDEX ix_dead_letters_arrived ON dead_letters (arrived_at);

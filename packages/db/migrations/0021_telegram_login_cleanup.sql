-- SPEC §9.3 — taking a spent link out of the chat it was sent to.
--
-- The link stops working the moment it is pressed, so leaving it is safe and it is not
-- tidy: a message that still reads "press this to sign in" invites a person to press it
-- again and wonder why nothing happens, and it looks like a live credential to anybody
-- reading over their shoulder. Neither is a vulnerability; both are avoidable.
--
-- The message id is written after the message is sent, because that is when Telegram says
-- what it is. `cleaned_at` records that the deletion was asked for, so a sweep that runs
-- twice does not ask twice and a Telegram outage does not lose the intent.
ALTER TABLE telegram_logins ADD COLUMN message_id TEXT;
ALTER TABLE telegram_logins ADD COLUMN cleaned_at TEXT;

-- The sweep: spent, delivered as a message, not yet cleaned. Empty on almost every pass.
CREATE INDEX ix_telegram_logins_spent ON telegram_logins (used_at)
  WHERE used_at IS NOT NULL AND cleaned_at IS NULL AND message_id IS NOT NULL;

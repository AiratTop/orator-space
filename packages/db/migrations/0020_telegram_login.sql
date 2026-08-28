-- SPEC §9.3 — signing in through the chat that is already bound to the account.
--
-- The other direction of §9.3's nonce. Linking sends a secret from the site into the chat;
-- this sends one from the chat to the browser: a person whose passkey is on a device they no
-- longer have asks the bot, and the bot answers with a link that opens a session.
--
-- Deliberately not the same table as `telegram_links`, though the shape is close. A link
-- nonce binds a chat and cannot open a session; this one opens a session and cannot bind a
-- chat. One table would make the difference a column, and a bug in a WHERE clause would make
-- a linking nonce into a credential — which is the whole of what this table must never do.
CREATE TABLE telegram_logins (
  nonce         TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals (id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  -- Which chat asked. Not for authorisation — the binding already answered that — but so an
  -- audit of "who signed in and from where" has the same shape here as everywhere else (§62).
  chat_id       TEXT NOT NULL
);
CREATE INDEX ix_telegram_logins_expiry ON telegram_logins (expires_at) WHERE used_at IS NULL;

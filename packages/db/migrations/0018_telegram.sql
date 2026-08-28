-- SPEC §9.3 — the second channel: a Telegram account bound to a principal.
--
-- One row per principal and one per Telegram account, both enforced by the schema rather
-- than by the service: a chat that could act for two accounts is an account-sharing
-- mechanism, and a principal with two chats is two places a recovery link can be sent to.
--
-- `chat_id` is stored beside `telegram_user_id` because they are different things — a bot
-- sends to a chat, and the private chat with a user usually has the same number, but nothing
-- in the protocol promises it. Sending to the wrong one is sending somebody else's
-- notification.
CREATE TABLE telegram_accounts (
  principal_id      TEXT PRIMARY KEY REFERENCES principals (id),
  telegram_user_id  TEXT NOT NULL,
  chat_id           TEXT NOT NULL,
  username          TEXT,                  -- may be absent: a Telegram account need not have one
  linked_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_telegram_user ON telegram_accounts (telegram_user_id);

-- The nonce a deep link carries (§9.3).
--
-- Issued by the signed-in page, redeemed once by the bot. Single use is `used_at`, and the
-- expiry is short: this is a credential that binds a chat to an account, and one that lives
-- in somebody's clipboard or browser history for a week is a credential somebody else can
-- use. Rows are swept by retention (§23.4) rather than deleted on redemption, so a second
-- attempt can be told "already used" rather than "never existed".
CREATE TABLE telegram_links (
  nonce         TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals (id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT
);
CREATE INDEX ix_telegram_links_expiry ON telegram_links (expires_at) WHERE used_at IS NULL;

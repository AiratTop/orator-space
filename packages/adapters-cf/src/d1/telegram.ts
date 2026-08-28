import type { NewTelegramLink, TelegramAccount, TelegramRepo } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

/** SPEC §9.3 over D1. */
interface AccountRow {
  principal_id: string;
  telegram_user_id: string;
  chat_id: string;
  username: string | null;
  linked_at: string;
}

interface LoginRow {
  nonce: string;
  principal_id: string;
  chat_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

interface LinkRow {
  nonce: string;
  principal_id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

const toAccount = (row: AccountRow | null): TelegramAccount | null =>
  row === null
    ? null
    : {
        principalId: row.principal_id as OratorId,
        telegramUserId: row.telegram_user_id,
        chatId: row.chat_id,
        username: row.username,
        linkedAt: row.linked_at,
      };

export function createTelegramRepo(db: D1Database): TelegramRepo {
  return {
    insertLink(link: NewTelegramLink) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO telegram_links (nonce, principal_id, created_at, expires_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(link.nonce, link.principalId, link.createdAt, link.expiresAt),
      );
    },

    async findLink(nonce) {
      const row = await db
        .prepare(`SELECT * FROM telegram_links WHERE nonce = ?`)
        .bind(nonce)
        .first<LinkRow>();
      return row === null
        ? null
        : {
            nonce: row.nonce,
            principalId: row.principal_id as OratorId,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            usedAt: row.used_at,
          };
    },

    markLinkUsed(nonce, at) {
      // `used_at IS NULL` in the WHERE is the single-use guarantee: two updates race, one
      // writes a row and the other writes none, and the service reads the count.
      return asWrite(
        db
          .prepare(`UPDATE telegram_links SET used_at = ? WHERE nonce = ? AND used_at IS NULL`)
          .bind(at, nonce),
      );
    },

    async findActiveLink(principalId, now) {
      const row = await db
        .prepare(
          `SELECT * FROM telegram_links
            WHERE principal_id = ? AND used_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(principalId, now)
        .first<LinkRow>();
      return row === null
        ? null
        : {
            nonce: row.nonce,
            principalId: row.principal_id as OratorId,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            usedAt: row.used_at,
          };
    },

    async findByPrincipal(principalId) {
      return toAccount(
        await db
          .prepare(`SELECT * FROM telegram_accounts WHERE principal_id = ?`)
          .bind(principalId)
          .first<AccountRow>(),
      );
    },

    async findByTelegramUser(telegramUserId) {
      return toAccount(
        await db
          .prepare(`SELECT * FROM telegram_accounts WHERE telegram_user_id = ?`)
          .bind(telegramUserId)
          .first<AccountRow>(),
      );
    },

    upsertAccount(account) {
      // Re-linking the same Telegram account to the same principal is idempotent: somebody
      // pressing start twice should get the same answer, not a constraint violation.
      return asWrite(
        db
          .prepare(
            `INSERT INTO telegram_accounts (principal_id, telegram_user_id, chat_id, username, linked_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (principal_id) DO UPDATE SET
               telegram_user_id = excluded.telegram_user_id,
               chat_id = excluded.chat_id,
               username = excluded.username,
               linked_at = excluded.linked_at`,
          )
          .bind(
            account.principalId,
            account.telegramUserId,
            account.chatId,
            account.username,
            account.linkedAt,
          ),
      );
    },

    deleteAccount(principalId) {
      return asWrite(db.prepare(`DELETE FROM telegram_accounts WHERE principal_id = ?`).bind(principalId));
    },

    /**
     * §61.2, §20.5 — private events whose audience has a chat, not yet delivered.
     *
     * `COALESCE(agent.owner_principal_id, p.id)` is the recipient: an agent cannot hold a
     * Telegram account, and §7.2 makes its owner the person accountable for it. The LEFT JOIN
     * on deliveries and the `IS NULL` is what makes this idempotent — a row leaves the queue
     * by being delivered, not by being read.
     */
    async listPendingNotifications(cutoff, limit) {
      const { results } = await db
        .prepare(
          `SELECT e.id, e.type, e.subject_type, e.subject_id, e.payload_json, e.created_at,
                  t.chat_id, t.principal_id AS recipient
             FROM events e
             JOIN principals p        ON p.id = e.audience_principal_id
             LEFT JOIN agents ag      ON ag.principal_id = p.id
             JOIN telegram_accounts t ON t.principal_id = COALESCE(ag.owner_principal_id, p.id)
             LEFT JOIN telegram_deliveries d ON d.event_id = e.id
            WHERE e.visibility = 'private'
              AND e.audience_principal_id IS NOT NULL
              AND e.created_at > ?
              AND d.event_id IS NULL
            ORDER BY e.created_at ASC
            LIMIT ?`,
        )
        .bind(cutoff, limit)
        .all<{
          id: string;
          type: string;
          subject_type: string;
          subject_id: string;
          payload_json: string | null;
          created_at: string;
          chat_id: string;
          recipient: string;
        }>();

      return results.map((row) => ({
        eventId: row.id as OratorId,
        type: row.type,
        chatId: row.chat_id,
        recipientPrincipalId: row.recipient as OratorId,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        payload: row.payload_json === null ? null : (JSON.parse(row.payload_json) as Record<string, unknown>),
        createdAt: row.created_at,
      }));
    },

    markDelivered(eventId, at) {
      // `OR IGNORE`, so a second pass over the same event after a crash writes nothing and
      // fails nothing: the primary key is the idempotency.
      return asWrite(
        db
          .prepare(`INSERT OR IGNORE INTO telegram_deliveries (event_id, sent_at) VALUES (?, ?)`)
          .bind(eventId, at),
      );
    },

    insertLogin(login) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO telegram_logins (nonce, principal_id, chat_id, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(login.nonce, login.principalId, login.chatId, login.createdAt, login.expiresAt),
      );
    },

    async findLogin(nonce) {
      const row = await db
        .prepare(`SELECT * FROM telegram_logins WHERE nonce = ?`)
        .bind(nonce)
        .first<LoginRow>();
      return row === null
        ? null
        : {
            nonce: row.nonce,
            principalId: row.principal_id as OratorId,
            chatId: row.chat_id,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            usedAt: row.used_at,
          };
    },

    markLoginUsed(nonce, at) {
      // The single-use guarantee is in the WHERE, as it is for a link: two redemptions race
      // and exactly one writes a row.
      return asWrite(
        db
          .prepare(`UPDATE telegram_logins SET used_at = ? WHERE nonce = ? AND used_at IS NULL`)
          .bind(at, nonce),
      );
    },

    async deleteLinksBefore(cutoff, limit) {
      const { meta } = await db
        .prepare(
          `DELETE FROM telegram_links
            WHERE nonce IN (SELECT nonce FROM telegram_links WHERE expires_at < ? LIMIT ?)`,
        )
        .bind(cutoff, limit)
        .run();
      return meta.changes ?? 0;
    },
  };
}

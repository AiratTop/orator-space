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

import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";

/** SPEC §9.3 — a Telegram account bound to a principal, and the nonce that bound it. */

export interface TelegramAccount {
  principalId: OratorId;
  telegramUserId: string;
  /** A bot sends to a chat; nothing in the protocol promises it equals the user id. */
  chatId: string;
  username: string | null;
  linkedAt: string;
}

export interface TelegramLink {
  nonce: string;
  principalId: OratorId;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface NewTelegramLink {
  nonce: string;
  principalId: OratorId;
  createdAt: string;
  expiresAt: string;
}

export interface TelegramRepo {
  insertLink(link: NewTelegramLink): PendingWrite;
  findLink(nonce: string): Promise<TelegramLink | null>;
  /** Single use, and the guard is the write: only an unused row is marked. */
  markLinkUsed(nonce: string, at: string): PendingWrite;

  /**
   * The most recent link this principal can still use, if any (§9.3).
   *
   * So that somebody who pressed connect, was interrupted, and came back is offered the link
   * they already have rather than a second one. Two live nonces for one account are two
   * credentials where one was asked for.
   */
  findActiveLink(principalId: string, now: string): Promise<TelegramLink | null>;

  findByPrincipal(principalId: string): Promise<TelegramAccount | null>;
  findByTelegramUser(telegramUserId: string): Promise<TelegramAccount | null>;
  upsertAccount(account: TelegramAccount): PendingWrite;
  deleteAccount(principalId: string): PendingWrite;

  /** §23.4 — nonces are swept rather than deleted on use, so a second attempt can be told. */
  deleteLinksBefore(cutoff: string, limit: number): Promise<number>;
}

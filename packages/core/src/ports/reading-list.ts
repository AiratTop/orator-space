import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";
import type { ArticleCard } from "./reading.js";

/**
 * A private reading list (SPEC §49.2, ADR 0011).
 *
 * Deliberately without a count. ADR 0011 refused a counter — a number a reader can increment
 * for free, which on a network of agents is a number with an unlimited supply — and this port
 * is shaped so that nothing can accidentally produce one: there is no `countFor`, no
 * `countOf`, and the only aggregate question it can answer is about the asking principal's
 * own list.
 */
export interface ReadingListRepo {
  /** Whether this principal has saved this article. One prefix seek on the primary key. */
  has(principalId: string, articleId: string): Promise<boolean>;
  /**
   * What this principal has saved, newest first.
   *
   * Keyset by article id like everything else (§44.2) — an id is time-ordered (§12.2), so
   * "newest first" and "stable under insertion" are the same ordering.
   */
  list(principalId: string, limit: number, before: string | null): Promise<ArticleCard[]>;
  save(principalId: string, articleId: OratorId, at: string): PendingWrite;
  remove(principalId: string, articleId: string): PendingWrite;
  /** SPEC §23.5 — somebody's private notes about their own reading go with the account. */
  removeAllFor(principalId: string): PendingWrite;
}

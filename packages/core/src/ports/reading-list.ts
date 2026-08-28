import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";
import type { ArticleCard } from "./reading.js";

/**
 * A private reading list (SPEC §49.2, ADR 0011).
 *
 * The one count it can produce is a principal's own, and the distinction is the whole of ADR
 * 0011. That decision refused a *public* counter: a number on a card, manufactured by a click,
 * read as a measure of an article's worth, and available to an agent without limit. There is
 * no way here to ask how many people saved an article — `countFor` takes a principal and not
 * an article, and that asymmetry is the rule expressed as a signature.
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
  /**
   * How many this principal has saved. Theirs, never an article's.
   *
   * The parameter is the reason this is allowed to exist: a count keyed by principal answers
   * "how long is my list" and cannot be assembled into "how popular is this article".
   */
  countFor(principalId: string): Promise<number>;
  save(principalId: string, articleId: OratorId, at: string): PendingWrite;
  remove(principalId: string, articleId: string): PendingWrite;
  /** SPEC §23.5 — somebody's private notes about their own reading go with the account. */
  removeAllFor(principalId: string): PendingWrite;
}

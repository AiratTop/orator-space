import { bandsOf, fromHex, isNearDuplicate, simhash, toHex } from "../text/simhash.js";
import type { Ports } from "./context.js";

/**
 * Indexing as an earned state (SPEC §50.3, §60.1).
 *
 * §50.2 states the conflict this exists to manage: a domain publishing large volumes of
 * machine-written text is the exact shape search engines have spent two years learning to
 * demote, and one bad article can cost every other article on the domain. §50.3's answer is
 * to move the risk from the domain to the article — a bad article is not indexed, and the
 * domain does not suffer for it.
 *
 * So `indexable` defaults to 0 and is granted, never assumed. Four conditions, evaluated
 * asynchronously after publishing, and **none of them blocks publishing**: §60.1 is explicit
 * that near-duplicate detection affects `indexable` and is a moderation signal, because
 * false positives on short news items are inevitable. An article that fails every condition
 * here is still published, still readable, still citable, still in the API. It is simply not
 * offered to a search engine as something this domain vouches for.
 */

/**
 * The volume and structure floor (§50.3, §60.1).
 *
 * Not a quality judgement — nothing here can make one. It is the threshold below which
 * there is not enough text for a search engine to distinguish the page from a stub, and
 * below which a duplicate check has nothing to work with either: two hundred words about
 * the same benchmark will always look alike.
 */
export const MIN_INDEXABLE_WORDS = 150;
export const MIN_INDEXABLE_PARAGRAPHS = 3;

/** How many band-collision candidates are worth examining before giving up (§18's rule). */
const MAX_CANDIDATES = 50;

export type IndexabilityReason =
  | "indexable"
  | "not_published"
  | "cross_post"
  | "unchecked"
  | "flagged"
  | "untrusted_author"
  | "too_short"
  | "near_duplicate"
  /** Byte-identical to something already published. Cheaper to find and stronger to state. */
  | "duplicate";

export interface IndexabilityOutcome {
  indexable: boolean;
  reason: IndexabilityReason;
  /** The near-duplicate that held it back, when that is the reason. */
  duplicateOf?: string;
}

/**
 * Evaluates one article and records the verdict.
 *
 * Runs from the queue on publish and on update, like screening, and for the same reason:
 * every input can change after the fact. A trust level rises on a schedule (§60.2), a
 * moderation verdict arrives asynchronously (§61), and an article that was the only one of
 * its kind yesterday may be a duplicate today because somebody else published.
 */
export async function evaluateIndexability(
  ports: Ports,
  articleId: string,
): Promise<IndexabilityOutcome> {
  const article = await ports.articles.findById(articleId);
  if (article === null) return record(ports, articleId, { indexable: false, reason: "not_published" }, null);

  if (article.status !== "published" || article.visibility !== "public") {
    return record(ports, articleId, { indexable: false, reason: "not_published" }, null);
  }

  /*
   * §60.1 — the exact duplicate, first and cheaply.
   *
   * `content_hash` is already on every revision and already unique per body, so this is an
   * index seek where the near-duplicate path below needs a body read, a fingerprint and four
   * band lookups. It goes here rather than beside that path because of what was found on
   * staging: three byte-identical articles recorded as `untrusted_author`, because the chain
   * returns at the first failing condition and trust came first. The duplication was true,
   * never written down, and would never have been re-examined when that trust rose.
   *
   * Before the cross-post and moderation checks too. Those describe what an article *is*;
   * this describes what it is a copy of, and the second fact is worth keeping whichever of
   * the first ones happens to be true.
   */
  if (article.publishedRevisionId !== null) {
    const published = await ports.articles.findRevision(article.publishedRevisionId);
    if (published !== null) {
      const original = await ports.articles.findByContentHash(published.contentHash, articleId);
      if (original !== null) {
        return record(
          ports,
          articleId,
          { indexable: false, reason: "duplicate", duplicateOf: original.id },
          null,
        );
      }
    }
  }

  /*
   * §15.1 — a cross-post is never indexed here, whatever else is true of it.
   *
   * The canonical points at somebody else's copy, and two copies of one text competing in
   * search results is the outcome §50.2 warns about with both of them losing. Checked before
   * anything expensive, because it can never be overturned by a later condition.
   */
  if (article.canonicalUrl !== null) {
    return record(ports, articleId, { indexable: false, reason: "cross_post" }, null);
  }

  if (article.moderationState === "unchecked") {
    // §61 — content nobody screened does not become indexable. That is what makes an
    // unavailable provider degrade the consequence rather than block the author.
    return record(ports, articleId, { indexable: false, reason: "unchecked" }, null);
  }
  if (article.moderationState === "flagged") {
    return record(ports, articleId, { indexable: false, reason: "flagged" }, null);
  }

  const author = await ports.principals.findById(article.authorPrincipalId);
  if ((author?.trustLevel ?? 0) < 1) {
    // §60.2 — level 0 is `noindex` by definition. Level 1 is a verified owner, seven days
    // of age and no violations: the ordinary state of an honest account, and a cost a
    // throwaway account has to pay in time rather than in effort (§60.3).
    return record(ports, articleId, { indexable: false, reason: "untrusted_author" }, null);
  }

  if (article.publishedRevisionId === null) {
    return record(ports, articleId, { indexable: false, reason: "not_published" }, null);
  }
  const revision = await ports.articles.findRevision(article.publishedRevisionId);
  const body = revision === null ? null : await ports.content.get(revision.contentHash);
  if (revision === null || body === null) {
    return record(ports, articleId, { indexable: false, reason: "not_published" }, null);
  }

  if (!meetsFloor(body)) {
    return record(ports, articleId, { indexable: false, reason: "too_short" }, null);
  }

  /*
   * The fingerprint is computed last, and only for an article that got this far.
   *
   * Every check above returns before the body is hashed, so a cross-post or an unscreened
   * article costs a row read rather than a hash and four index seeks. It also means the
   * fingerprints in the table are exactly the set another article can be a duplicate *of* —
   * which is the right set, because an article nobody may index is not one worth protecting
   * the index from a copy of.
   */
  const fingerprint = simhash(`${revision.title}\n\n${body}`);
  const hex = toHex(fingerprint);

  const candidates = await ports.articles.findBySimhashBands(bandsOf(fingerprint), articleId, MAX_CANDIDATES);
  const duplicate = candidates.find((candidate) => isNearDuplicate(fingerprint, fromHex(candidate.simhash)));

  if (duplicate !== undefined) {
    // Not blocked, not hidden, not reported. §60.1 says this affects `indexable` and is a
    // signal — the article stays published and citable, and the domain does not offer a
    // second copy of something it already offered.
    return record(ports, articleId, { indexable: false, reason: "near_duplicate", duplicateOf: duplicate.id }, hex);
  }

  return record(ports, articleId, { indexable: true, reason: "indexable" }, hex);
}

/** SPEC §50.3 — enough text to be worth offering, and enough shape to be readable. */
export function meetsFloor(body: string): boolean {
  const words = (body.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).length;
  if (words < MIN_INDEXABLE_WORDS) return false;

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith("#")).length;
  return paragraphs >= MIN_INDEXABLE_PARAGRAPHS;
}

async function record(
  ports: Ports,
  articleId: string,
  outcome: IndexabilityOutcome,
  hex: string | null,
): Promise<IndexabilityOutcome> {
  const article = await ports.articles.findById(articleId);
  const reason = outcome.duplicateOf ? `${outcome.reason}:${outcome.duplicateOf}` : outcome.reason;
  const duplicateOf = outcome.duplicateOf ?? null;

  // Nothing to do when the verdict has not moved. §50.3 requires a sitemap rebuild on a
  // change to `indexable`, and a write on every replayed queue message would rebuild it
  // constantly for no reason (§35.3).
  if (article !== null && article.indexable === outcome.indexable && article.indexableReason === reason) {
    return outcome;
  }

  const now = ports.clock.now().toISOString();

  /*
   * §60.1 — a duplicate is a moderation signal, and a signal that ends in a column is not
   * one. The report is raised the first time the pointer appears, which the guard above
   * makes exactly once: a replayed message finds the verdict unmoved and returns.
   *
   * `insertReport` and not an action. Nothing is decided here — §61 gives an automatic
   * verdict a report and nothing more, and which of two identical articles is the copy is a
   * question a person may answer differently from the ordering by id.
   */
  const newlyDuplicate = duplicateOf !== null && article?.duplicateOf !== duplicateOf;

  await ports.db.commit([
    ports.articles.setIndexability(
      articleId,
      { indexable: outcome.indexable, reason, duplicateOf, simhash: hex ?? article?.simhash ?? null },
      now,
    ),
    ...(newlyDuplicate
      ? [
          ports.moderation.insertReport({
            id: ports.ids.next(),
            targetType: "article",
            targetId: articleId,
            reporterPrincipalId: null,
            reporterContact: null,
            category: "other",
            details: `Byte-identical to ${duplicateOf}. Detected automatically (§60.1); the ordering by id says which was published first, not which is the copy.`,
            createdAt: now,
          }),
        ]
      : []),
  ]);
  return outcome;
}

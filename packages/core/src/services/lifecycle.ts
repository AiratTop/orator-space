import { ErrorType, SCHEMA_VERSION, type OratorId } from "@orator/protocol";
import { canModify, type DenialReason } from "../identity/authz.js";
import type { ArticleRecord, Disclosure, Visibility } from "../ports/index.js";
import { fail, ok, type RequestContext, type Result } from "./context.js";

/**
 * The end of an article's life, and the metadata changes along the way (SPEC §23).
 *
 * Version 1.0 of the specification had one `DELETE` and an irreconcilable set of promises
 * around it: immutable revisions, permanently stable ids, a citation graph, and a right to
 * erasure that was not mentioned at all. §23 resolves that into three operations that were
 * being called by one name, and this module is where the difference is enforced.
 *
 *   unpublish  reversible; the article stops being public and keeps everything
 *   remove     a tombstone; 410 forever, id kept, incoming citations still resolve
 *   erase      the bytes are destroyed; the record of the article survives as evidence
 */

const DENIAL_DETAIL: Record<DenialReason, string> = {
  suspended: "This principal is suspended.",
  "insufficient-scope": "The token does not carry the required scope.",
  "not-owner": "This principal does not own the article.",
  "cross-agent": "An agent cannot act on a sibling agent's articles, even under the same owner.",
  "requires-moderator": "This action requires a moderator or administrator.",
};

const denied = <T>(reason: DenialReason): Result<T> =>
  fail(
    reason === "insufficient-scope" ? ErrorType.InsufficientScope : ErrorType.Forbidden,
    "Not permitted",
    DENIAL_DETAIL[reason],
  );

const ownershipOf = (article: ArticleRecord) => ({
  authorPrincipalId: article.authorPrincipalId,
  ...(article.authorOwnerPrincipalId === undefined
    ? {}
    : { authorOwnerPrincipalId: article.authorOwnerPrincipalId }),
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface PatchArticleInput {
  visibility?: Visibility;
  authorshipDisclosure?: Disclosure;
  canonicalUrl?: string | null;
  language?: string;
  /** SPEC §50.1 — the article's own preview image. Null clears it (§44.2's merge). */
  featuredMediaId?: string | null;
}

/**
 * Changes an article's metadata (SPEC §44.2 merge semantics).
 *
 * Content is not among the fields, and cannot be. A revision is immutable (§16.1), so
 * changing what an article says means creating a new revision — which is a different
 * endpoint with an `If-Match` precondition, because that is a change worth a concurrency
 * check and this is not.
 */
export async function updateArticle(
  ctx: RequestContext,
  articleId: string,
  input: PatchArticleInput,
): Promise<Result<{ id: OratorId; visibility: Visibility }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const article = await ctx.ports.articles.findById(articleId);
  if (article === null) return fail(ErrorType.NotFound, "Article not found");
  if (article.status === "removed") return fail(ErrorType.Gone, "Article was removed");

  const permitted = canModify(actor, ownershipOf(article), "articles:write");
  if (!permitted.allowed) return denied(permitted.reason);

  // §10 — an agent cannot relabel its output as human-authored. The client may narrow
  // within what is true and never contradict it, exactly as at creation time.
  if (input.authorshipDisclosure !== undefined && actor.kind === "agent" && input.authorshipDisclosure !== "ai_generated") {
    return fail(
      ErrorType.ValidationFailed,
      "An agent cannot change the disclosure of origin",
      "Content produced by an agent is ai_generated, and saying otherwise is the one thing §10 exists to prevent.",
    );
  }

  /*
   * §50.1, §21.2 — the preview image must be one this platform holds and this caller owns.
   *
   * An id rather than a URL is already half of it: nothing here can point a page's `og:image`
   * at bytes this domain has never seen. The other half is ownership — without it, an article
   * could be previewed by somebody else's picture, which is a claim about authorship made in
   * the one place every social client repeats verbatim.
   */
  if (input.featuredMediaId !== undefined && input.featuredMediaId !== null) {
    const media = await ctx.ports.media.findById(input.featuredMediaId);
    if (media === null || media.status !== "ready" || media.kind !== "image") {
      return fail(ErrorType.ValidationFailed, "No such image", "The media must exist and be ready.", {
        field: "featured_media_id",
      });
    }
    if (media.ownerPrincipalId !== actor.principalId) {
      return fail(ErrorType.Forbidden, "Not permitted", "An article is previewed by its author's own image.");
    }
  }

  const now = ctx.ports.clock.now().toISOString();
  const writes = [];

  const metadata = {
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    ...(input.authorshipDisclosure === undefined ? {} : { authorshipDisclosure: input.authorshipDisclosure }),
    ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(input.featuredMediaId === undefined ? {} : { featuredMediaId: input.featuredMediaId }),
  };
  if (Object.keys(metadata).length > 0) {
    writes.push(ctx.ports.articles.updateMetadata(article.id, metadata, now));
  }

  if (writes.length === 0) {
    return ok({ id: article.id, visibility: article.visibility });
  }

  // A visibility change makes an article appear or disappear from the public surface, so
  // the derived data has to hear about it — same event, same handler as publishing (§38.1).
  writes.push(
    ctx.ports.outbox.enqueue({
      id: ctx.ports.ids.next(),
      eventType: "article.updated",
      aggregateType: "article",
      aggregateId: article.id,
      payload: { schema_version: SCHEMA_VERSION, ...metadata },
      requestId: ctx.requestId,
      createdAt: now,
    }),
  );

  await ctx.ports.db.commit(writes);
  return ok({ id: article.id, visibility: input.visibility ?? article.visibility });
}

// ---------------------------------------------------------------------------
// Remove — the tombstone (§23.2)
// ---------------------------------------------------------------------------

export async function removeArticle(
  ctx: RequestContext,
  articleId: string,
): Promise<Result<{ id: OratorId; status: "removed"; removedAt: string }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const article = await ctx.ports.articles.findById(articleId);
  if (article === null) return fail(ErrorType.NotFound, "Article not found");

  const permitted = canModify(actor, ownershipOf(article), "articles:delete");
  if (!permitted.allowed) return denied(permitted.reason);

  const now = ctx.ports.clock.now().toISOString();
  if (article.status === "removed") {
    // Idempotent: a retry of a removal is the same state, and a client that retried
    // because it lost the response should not have to interpret an error.
    return ok({ id: article.id, status: "removed", removedAt: article.removedAt ?? now });
  }

  await ctx.ports.db.commit([
    ctx.ports.articles.setStatus(article.id, "removed", now),
    // The edges into this article are deliberately left alone. §23.2 keeps incoming
    // citations resolving, displayed as "the cited article was removed" — deleting them
    // would rewrite other authors' work to hide that this one existed.
    ctx.ports.events.insert({
      id: ctx.ports.ids.next(),
      type: "article.removed",
      actorPrincipalId: actor.principalId as OratorId,
      subjectType: "article",
      subjectId: article.id,
      audiencePrincipalId: null,
      visibility: "public",
      payload: { schema_version: SCHEMA_VERSION, article_id: article.id },
      createdAt: now,
    }),
    ctx.ports.outbox.enqueue({
      id: ctx.ports.ids.next(),
      eventType: "article.removed",
      aggregateType: "article",
      aggregateId: article.id,
      payload: { schema_version: SCHEMA_VERSION },
      requestId: ctx.requestId,
      createdAt: now,
    }),
  ]);

  return ok({ id: article.id, status: "removed", removedAt: now });
}

// ---------------------------------------------------------------------------
// Erase — the right to erasure (§23.3)
// ---------------------------------------------------------------------------

export type EraseOutcome = {
  id: OratorId;
  revisions: number;
  /** True when the stored object was deleted; false when another revision still needs it. */
  contentDeleted: boolean;
  /** §23.3 step 4 — someone else's revision is byte-identical, and a person must look. */
  escalated: boolean;
  /**
   * Bodies that acquired a live reference between the reference check and the delete.
   *
   * Not a failure and not `escalated`: content is addressed by hash, so a publisher of the
   * same bytes arriving mid-erasure is an ordinary race with nobody to escalate to. The
   * pointers are blanked either way; the object is left for §32's collector.
   */
  raced: number;
};

/**
 * Destroys an article's content permanently.
 *
 * The ordering below is not an implementation detail, it is the whole of §23.3. Content
 * storage is addressed by hash, so one object can be referenced by revisions of different
 * articles by different authors. Deleting the object named by `content_ref` without
 * checking silently destroys someone else's article.
 */
export async function eraseArticle(
  ctx: RequestContext,
  articleId: string,
  input: { confirm: string; reason?: string | null },
): Promise<Result<EraseOutcome>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  if (input.confirm !== "erase") {
    return fail(
      ErrorType.ValidationFailed,
      "Erasure must be confirmed",
      'Send {"confirm":"erase"}. The bytes are deleted and do not come back.',
    );
  }

  const article = await ctx.ports.articles.findById(articleId);
  if (article === null) return fail(ErrorType.NotFound, "Article not found");

  const permitted = canModify(actor, ownershipOf(article), "articles:delete");
  if (!permitted.allowed) return denied(permitted.reason);

  /**
   * A human, not merely a token carrying the scope.
   *
   * Erasure is the one operation here that destroys evidence, and it exists to answer a
   * legal demand made by a person. §7.2 makes every agent accountable to a human; this is
   * the point at which that accountability has to be exercised rather than delegated.
   */
  if (actor.kind !== "human") {
    return fail(
      ErrorType.Forbidden,
      "Erasure requires a human actor",
      "An agent may withdraw or remove its own work. Destroying the content permanently is an act its accountable owner performs.",
    );
  }

  /*
   * The whole history, and counted rather than listed (§23.3).
   *
   * This used to read a page of two hundred revisions and work from that, which is wrong in
   * a way that reported success: an article with more revisions kept the older ones, text
   * and `content_ref` intact — and those surviving rows then counted as outside references,
   * so step 3 refused to delete the R2 object as well. A partial erasure that answers 200 is
   * worse than a failure, because the demand it exists to satisfy is a legal one.
   */
  const bodies = await ctx.ports.articles.contentReferences(article.id);
  const now = ctx.ports.clock.now().toISOString();

  let escalated = false;
  const deletable: string[] = [];

  // Steps 1-3 of §23.3, in one query rather than a count per distinct body.
  for (const { contentHash, elsewhere } of bodies) {
    if (elsewhere === 0) {
      deletable.push(contentHash);
      continue;
    }

    // Step 4. Another revision — possibly another author's — is byte-identical to this
    // one. That is either plagiarism or the same personal data published twice, and both
    // need a person to decide. The object stays; only this article's pointers are blanked.
    escalated = true;
  }

  const erasedCount = bodies.reduce((total, body) => total + body.mine, 0);

  const writes = [
    ctx.ports.articles.eraseRevisionsOf(article.id, now),
    ctx.ports.articles.setStatus(article.id, "removed", now),
    ctx.ports.audit.record({
      id: ctx.ports.ids.next(),
      actorPrincipalId: actor.principalId as OratorId,
      actorTokenId: ctx.tokenId,
      action: "article.erased",
      targetType: "article",
      targetId: article.id,
      outcome: "success",
      // §23.3 — what survives is the trace: the hashes, the time, the actor. Not the text.
      reason: input.reason ?? null,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      createdAt: now,
    }),
    ctx.ports.outbox.enqueue({
      id: ctx.ports.ids.next(),
      eventType: "article.removed",
      aggregateType: "article",
      aggregateId: article.id,
      payload: { schema_version: SCHEMA_VERSION, erased: true, escalated },
      requestId: ctx.requestId,
      createdAt: now,
    }),
  ];

  await ctx.ports.db.commit(writes);

  /**
   * The object is deleted after the pointers are blanked, and the order is the point.
   *
   * If the commit fails, nothing has been destroyed and the request can be retried. If the
   * delete fails, the pointers are already gone and the object is an orphan — which the
   * garbage collector (§32) is there to collect, and which no reader can reach in the
   * meantime. The other order trades a recoverable orphan for a live article pointing at
   * bytes that are not there.
   */
  /*
   * Re-checked after the commit, because the check that chose these hashes ran before it.
   *
   * Content is addressed by hash (§16.2), so between deciding and deleting, somebody else
   * publishing byte-identical text acquires a live reference to the very object about to be
   * destroyed — and they would be left with an article pointing at bytes that are not there.
   * The window is small and the consequence is somebody else's article, so it is worth one
   * more query.
   *
   * This narrows the window rather than closing it: nothing here holds a lock over a hash, and
   * closing it takes a state machine rather than a check — ADR 0015 records the protocol and
   * why it is not built. The order below is the other half: the pointers are already blanked,
   * so a failure leaves a collectable orphan rather than a live article with no body.
   */
  const stillUnreferenced = new Set(
    (await ctx.ports.articles.contentReferences(article.id))
      .filter((body) => body.elsewhere === 0)
      .map((body) => body.contentHash),
  );

  const removable: string[] = [];
  let raced = 0;
  for (const hash of deletable) {
    if (!stillUnreferenced.has(hash)) {
      /*
       * Somebody published the same bytes while this ran, and their article now points at
       * the object. It stays.
       *
       * Counted rather than folded into `escalated`: that flag went into the outbox event
       * inside the commit above and is already delivered, and it means something specific —
       * §23.3 step 4, a byte-identical revision that needs a person to look. This is a
       * scheduling accident with nobody to escalate to, and §32's collector is what removes
       * the object once that new reference goes away.
       */
      raced += 1;
      continue;
    }
    removable.push(hash);
  }

  // One call rather than one per body: an article with 250 distinct bodies made 250
  // sequential round trips to the store, inside a request somebody is waiting on.
  await ctx.ports.content.deleteMany(removable);
  const contentDeleted = removable.length > 0;

  return ok({ id: article.id, revisions: erasedCount, contentDeleted, escalated, raced });
}

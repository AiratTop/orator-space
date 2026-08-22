import { ErrorType, SCHEMA_VERSION, type OratorId } from "@orator/protocol";
import type { ArticleRecord, Disclosure, RevisionRecord } from "../ports/index.js";
import { canCreate, canModify, type DenialReason } from "../identity/authz.js";
import { keyValidAt, revisionSigningInput, verifySignature } from "../identity/keys.js";
import { slugify, validateContent } from "../articles/content.js";
import { fail, ok, withinQuota, type RequestContext, type Result } from "./context.js";

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

/**
 * Disclosure is derived, not merely accepted (SPEC §10).
 *
 * An agent cannot claim its output was written by a human. The client may narrow within
 * what is true, never contradict it — a self-declared field would make the guarantee
 * worthless exactly where it matters.
 */
function resolveDisclosure(authorKind: "human" | "agent", requested: Disclosure | undefined): Disclosure {
  if (authorKind === "agent") return "ai_generated";
  return requested ?? "ai_assisted";
}

export interface CreateArticleInput {
  title: string;
  content: string;
  slug?: string | null;
  language?: string;
  visibility?: "public" | "unlisted" | "private";
  authorshipDisclosure?: Disclosure;
  /** SPEC §15.1 — the primary publication's address, when it is not this one. */
  canonicalUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ArticleSummary {
  id: OratorId;
  revisionId: OratorId;
  slug: string | null;
  status: string;
  contentHash: string;
  /**
   * When the revision was created, which is a server-assigned field the agent must have.
   *
   * §8.3 signs `article_id`, `revision_id`, `content_hash` and `created_at`. Three of those
   * were already here; without the fourth an agent cannot sign what it just wrote, and the
   * publish call refuses it.
   */
  createdAt: string;
  url: string;
}

/**
 * Creates a draft article and its first revision (SPEC §16).
 *
 * The body goes to R2 before anything is written to D1: if content storage fails, no row
 * exists pointing at a body that is not there.
 */
export async function createArticle(
  ctx: RequestContext,
  input: CreateArticleInput,
): Promise<Result<ArticleSummary>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const permitted = canCreate(actor, "articles:write");
  if (!permitted.allowed) return denied(permitted.reason);

  // §59.2 — charged before anything is written, so a refusal leaves no draft behind.
  const allowance = await withinQuota(ctx, "articles.draft");
  if (!allowance.ok) return allowance;

  const validated = validateContent(input.title, input.content);
  if ("error" in validated) {
    return fail(ErrorType.ValidationFailed, "Article content is not valid", validated.error);
  }

  const articleId = ctx.ports.ids.next();
  const revisionId = ctx.ports.ids.next();
  const createdAt = ctx.ports.clock.now().toISOString();
  const contentHash = await ctx.ports.content.put(validated.content);
  const slug = input.slug === undefined ? slugify(validated.title) : input.slug;

  await ctx.ports.db.commit([
    ctx.ports.articles.insertArticle({
      id: articleId,
      authorPrincipalId: actor.principalId as OratorId,
      slug: slug === "" ? null : slug,
      language: input.language ?? "en",
      authorshipDisclosure: resolveDisclosure(actor.kind, input.authorshipDisclosure),
      visibility: input.visibility ?? "public",
      canonicalUrl: input.canonicalUrl ?? null,
      createdAt,
    }),
    ctx.ports.articles.insertRevision({
      id: revisionId,
      articleId,
      parentRevisionId: null,
      title: validated.title,
      excerpt: validated.excerpt,
      contentRef: ctx.ports.content.refFor(contentHash),
      contentHash,
      contentBytes: validated.contentBytes,
      readingTimeSeconds: validated.readingTimeSeconds,
      metadata: { schema_version: SCHEMA_VERSION, ...(input.metadata ?? {}) },
      createdByPrincipalId: actor.principalId as OratorId,
      viaTokenId: ctx.tokenId,
      createdAt,
    }),
    ctx.ports.articles.setCurrentRevision(articleId, revisionId, null, createdAt),
  ]);

  // No event: a draft is not activity. Publishing is what the network observes (§20).
  return ok({
    id: articleId,
    revisionId,
    slug: slug === "" ? null : slug,
    status: "draft",
    contentHash,
    createdAt,
    url: urlFor(articleId, slug),
  });
}

export interface CreateRevisionInput {
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  /** SPEC §34.3 — the revision the caller believes is current. */
  ifMatch?: string | null;
}

export interface RevisionSummary {
  id: OratorId;
  articleId: OratorId;
  contentHash: string;
  /** §8.4 — assigned here, and required to build the string the agent signs. */
  createdAt: string;
  /** §16.4 — identical content creates no revision, and says so rather than lying. */
  unchanged: boolean;
}

export async function createRevision(
  ctx: RequestContext,
  articleId: string,
  input: CreateRevisionInput,
): Promise<Result<RevisionSummary>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const article = await ctx.ports.articles.findById(articleId);
  if (article === null || article.status === "removed") {
    return fail(ErrorType.NotFound, "Article not found");
  }

  const permitted = canModify(actor, ownershipOf(article), "articles:write");
  if (!permitted.allowed) return denied(permitted.reason);

  const validated = validateContent(input.title, input.content);
  if ("error" in validated) {
    return fail(ErrorType.ValidationFailed, "Article content is not valid", validated.error);
  }

  if (input.ifMatch !== undefined && input.ifMatch !== null && input.ifMatch !== article.currentRevisionId) {
    return fail(
      ErrorType.PreconditionFailed,
      "Article has changed since you last read it",
      "Re-read the article and reapply your change.",
      { current_revision_id: article.currentRevisionId },
    );
  }

  const current = article.currentRevisionId === null ? null : await ctx.ports.articles.findRevision(article.currentRevisionId);
  const contentHash = await ctx.ports.content.put(validated.content);

  // A retrying agent that resends identical content should not accumulate empty
  // revisions; over a week of retries that is thousands of rows saying nothing (§16.4).
  if (current !== null && current.contentHash === contentHash && current.title === validated.title) {
    return ok({
      id: current.id,
      articleId: article.id,
      contentHash,
      createdAt: current.createdAt,
      unchanged: true,
    });
  }

  const revisionId = ctx.ports.ids.next();
  const createdAt = ctx.ports.clock.now().toISOString();

  const [, pointer] = await ctx.ports.db.commit([
    ctx.ports.articles.insertRevision({
      id: revisionId,
      articleId: article.id,
      parentRevisionId: article.currentRevisionId,
      title: validated.title,
      excerpt: validated.excerpt,
      contentRef: ctx.ports.content.refFor(contentHash),
      contentHash,
      contentBytes: validated.contentBytes,
      readingTimeSeconds: validated.readingTimeSeconds,
      metadata: { schema_version: SCHEMA_VERSION, ...(input.metadata ?? {}) },
      createdByPrincipalId: actor.principalId as OratorId,
      viaTokenId: ctx.tokenId,
      createdAt,
    }),
    // Conditional on the pointer we read, so a concurrent writer loses rather than
    // silently overwriting. Reading first and then writing would be a race (§34.3).
    ctx.ports.articles.setCurrentRevision(article.id, revisionId, article.currentRevisionId, createdAt),
  ]);

  if ((pointer?.changes ?? 0) === 0) {
    return fail(
      ErrorType.Conflict,
      "Another revision was created concurrently",
      "Re-read the article and reapply your change.",
    );
  }

  return ok({ id: revisionId, articleId: article.id, contentHash, createdAt, unchanged: false });
}

export interface PublishInput {
  /** Defaults to the current revision. */
  revisionId?: string;
  /** SPEC §15.1 — the original publication date, when the article was published elsewhere first. */
  publishedAt?: string | null;
  /** SPEC §8.4 — signed after the revision exists, because the server assigns its id. */
  signature?: string | null;
  signatureKeyId?: string | null;
}

/**
 * Publishes by moving a pointer (SPEC §16.3).
 *
 * The critical path ends here: everything downstream — indexing, sitemap, cache purge,
 * notifications — is driven by the outbox row written in this same transaction (§36).
 */
export async function publishArticle(
  ctx: RequestContext,
  articleId: string,
  input: PublishInput = {},
): Promise<Result<{ id: OratorId; revisionId: string; url: string; publishedAt: string; signed: boolean }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const article = await ctx.ports.articles.findById(articleId);
  if (article === null || article.status === "removed") {
    return fail(ErrorType.NotFound, "Article not found");
  }

  const permitted = canModify(actor, ownershipOf(article), "articles:publish");
  if (!permitted.allowed) return denied(permitted.reason);

  /*
   * Charged against the article's author, not the caller.
   *
   * An owner may publish on behalf of an agent they own (§43.2). The limit belongs to the
   * principal whose name goes on the article — otherwise one owner with ten agents has ten
   * times the publishing allowance of one agent, which is §60.3's sybil argument reproduced
   * inside a single account.
   *
   * Only on the first publish: republishing a corrected revision is the same article, and
   * charging for it would make an author choose between fixing a mistake and publishing
   * something new.
   */
  if (article.publishedAt === null) {
    const allowance = await withinQuota(ctx, "articles.publish", article.authorPrincipalId);
    if (!allowance.ok) return allowance;
  }

  const revisionId = input.revisionId ?? article.currentRevisionId;
  if (revisionId === null) {
    return fail(ErrorType.ValidationFailed, "Article has no revision to publish");
  }
  const revision = await ctx.ports.articles.findRevision(revisionId);
  if (revision === null || revision.articleId !== article.id) {
    return fail(ErrorType.NotFound, "Revision not found");
  }

  const writes = [];
  let signed = false;

  const now = ctx.ports.clock.now().toISOString();

  /*
   * The date the article claims, which is not always the moment this happened (§15.1).
   *
   * Import is a standing mode rather than a migration, and an imported article must carry
   * the date it was first published. Everything else here stays on `now`: the signature is
   * being made now, so key validity is judged now, and an event dated 2019 would land in
   * the wrong place in an ordered journal (§20).
   */
  const publishedAt = input.publishedAt ?? now;
  if (input.publishedAt !== undefined && input.publishedAt !== null) {
    if (publishedAt > now) {
      return fail(
        ErrorType.ValidationFailed,
        "A publication date cannot be in the future",
        "The feed orders on this date (§37.1); a future one would sit at the head of every feed until the clock caught up.",
      );
    }
    if (article.publishedAt !== null) {
      // Refused rather than ignored. The column is filled once by design (§16.3), so
      // accepting the field and discarding it would be a silent no-op on the one field an
      // importer most wants to be sure of.
      return fail(
        ErrorType.Conflict,
        "This article already has a publication date",
        "published_at is set the first time an article is published and is not restamped.",
      );
    }
  }

  const signature = input.signature ?? null;
  const signatureKeyId = input.signatureKeyId ?? null;
  if (signature !== null && signatureKeyId !== null) {
    const verdict = await verifyRevisionSignature(ctx, article, revision, signature, signatureKeyId, now);
    if (!verdict.ok) return verdict;
    writes.push(ctx.ports.articles.attachSignature(revision.id, signature, signatureKeyId));
    signed = true;
  }

  writes.push(
    ctx.ports.articles.publish(article.id, revision.id, now, publishedAt),
    // Same transaction. A queue send after the commit is not atomic with it, and the gap
    // is silent: the article publishes and nothing downstream ever hears (§35.1).
    ctx.ports.outbox.enqueue({
      id: ctx.ports.ids.next(),
      eventType: "article.published",
      aggregateType: "article",
      aggregateId: article.id,
      payload: {
        schema_version: SCHEMA_VERSION,
        revision_id: revision.id,
        content_hash: revision.contentHash,
        author_principal_id: article.authorPrincipalId,
        slug: article.slug,
        signed,
      },
      requestId: ctx.requestId,
      createdAt: now,
    }),
    ctx.ports.events.insert({
      id: ctx.ports.ids.next(),
      type: "article.published",
      actorPrincipalId: article.authorPrincipalId,
      subjectType: "article",
      subjectId: article.id,
      audiencePrincipalId: null,
      visibility: "public",
      payload: { schema_version: SCHEMA_VERSION, title: revision.title },
      // `now`, not the article's date. An imported article is published today whatever
      // date it carries, and an event stamped 2019 would sort into the wrong place in a
      // journal that is read by cursor (§20.5).
      createdAt: now,
    }),
  );

  await ctx.ports.db.commit(writes);

  return ok({
    id: article.id,
    revisionId: revision.id,
    url: urlFor(article.id, article.slug),
    publishedAt,
    signed,
  });
}

async function verifyRevisionSignature(
  ctx: RequestContext,
  article: ArticleRecord,
  revision: RevisionRecord,
  signature: string,
  keyId: string,
  signedAt: string,
): Promise<Result<true>> {
  const key = await ctx.ports.keys.findById(keyId);
  if (key === null) return fail(ErrorType.ValidationFailed, "Signing key not found");
  if (key.agentPrincipalId !== article.authorPrincipalId) {
    return fail(
      ErrorType.ValidationFailed,
      "Signing key does not belong to the author",
      "A revision may only be signed by a key registered to the principal it is attributed to.",
    );
  }
  // The signature is made now, over a revision that may be much older: an author writes a
  // draft, later registers a key, then signs and publishes. What matters is that the key
  // is usable at signing time, not that it predates the content it attests to.
  if (!keyValidAt(key, signedAt)) {
    return fail(
      ErrorType.ValidationFailed,
      "Signing key is not currently valid",
      "The key has been revoked. Register a new one and sign with that.",
    );
  }

  const message = revisionSigningInput({
    articleId: article.id,
    revisionId: revision.id,
    contentHash: revision.contentHash,
    createdAt: revision.createdAt,
  });
  if (!(await verifySignature(key.publicKey, signature, message))) {
    return fail(
      ErrorType.ValidationFailed,
      "Signature does not verify",
      "Sign the canonical string returned with the revision, exactly as given.",
    );
  }
  return ok(true);
}

export async function unpublishArticle(
  ctx: RequestContext,
  articleId: string,
): Promise<Result<{ id: string; status: string }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const article = await ctx.ports.articles.findById(articleId);
  if (article === null || article.status === "removed") {
    return fail(ErrorType.NotFound, "Article not found");
  }
  const permitted = canModify(actor, ownershipOf(article), "articles:publish");
  if (!permitted.allowed) return denied(permitted.reason);

  const at = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([
    // published_revision_id is kept: unpublishing is reversible and is not a deletion
    // (SPEC §23.1). Removal is a different operation entirely.
    ctx.ports.articles.unpublish(article.id, at),
    ctx.ports.outbox.enqueue({
      id: ctx.ports.ids.next(),
      eventType: "article.unpublished",
      aggregateType: "article",
      aggregateId: article.id,
      payload: { schema_version: SCHEMA_VERSION },
      requestId: ctx.requestId,
      createdAt: at,
    }),
  ]);
  return ok({ id: article.id, status: "unpublished" });
}

/** Canonical URL (SPEC §11). The id carries identity; the slug is decoration. */
export const urlFor = (articleId: string, slug: string | null): string =>
  slug === null || slug === "" ? `/p/${articleId}` : `/p/${articleId}/${slug}`;

export interface ArticleForActor {
  article: ArticleRecord;
  revision: RevisionRecord;
  /** Null when the bytes were erased under §23.3: the record survives, the body does not. */
  body: string | null;
  /**
   * Whether this caller is the author or their owner.
   *
   * Carried out of the service rather than recomputed by each adapter, because it decides
   * what may be said about an unpublished draft — and a rule about draft visibility that is
   * evaluated twice is a rule that will eventually be evaluated two ways (§43.2).
   */
  canSeeDraft: boolean;
}

/**
 * Reads an article as this actor is allowed to see it.
 *
 * Here rather than in an HTTP handler because it answers an authorisation question, and
 * §43.4 is explicit that REST, MCP and the web must reach the same verdict on one. It
 * lived in the REST route until MCP needed the same answer — at which point the choice was
 * to move it or to have two versions of "may this caller see the draft", which is the kind
 * of divergence that shows up as a leak rather than as a bug report.
 *
 * The published revision is what anybody sees. The current unpublished one is visible to
 * its author and to the human accountable for that author, and to nobody else.
 */
export async function readArticle(
  ctx: RequestContext,
  id: string,
): Promise<Result<ArticleForActor>> {
  const article = await ctx.ports.articles.findById(id);
  if (article === null) return fail(ErrorType.NotFound, "Article not found");
  if (article.status === "removed") {
    /*
     * 410, not 404: the article existed, the identifier is permanent, and a citation to it
     * must keep resolving to something that says so (§23.2).
     *
     * 451 when a legal order took it down (§61.1). The distinction is not decoration: a
     * crawler, a citing author and a court all read those two codes differently, and a
     * platform that answered 410 for both would be concealing which of its removals were
     * compelled. The reason is stated; who compelled it is not, because that is frequently
     * not ours to publish.
     */
    return article.removalSource === "legal"
      ? fail(
          ErrorType.UnavailableForLegalReasons,
          "Removed in response to a legal demand",
          "The identifier still resolves and citations to it still answer.",
        )
      : fail(ErrorType.Gone, "Article was removed");
  }

  const viewer = ctx.actor?.principalId;
  const canSeeDraft =
    viewer !== undefined &&
    (viewer === article.authorPrincipalId || viewer === article.authorOwnerPrincipalId);
  const revisionId = article.publishedRevisionId ?? (canSeeDraft ? article.currentRevisionId : null);
  // Not "forbidden": to a caller with no right to the draft, an unpublished article is
  // indistinguishable from one that does not exist, and saying otherwise leaks its existence.
  if (revisionId === null) return fail(ErrorType.NotFound, "Article not found");

  const revision = await ctx.ports.articles.findRevision(revisionId);
  if (revision === null) return fail(ErrorType.NotFound, "Revision not found");

  return ok({
    article,
    revision,
    body: await ctx.ports.content.get(revision.contentHash),
    canSeeDraft,
  });
}

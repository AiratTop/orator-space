import { ErrorType, SCHEMA_VERSION, type OratorId } from "@orator/protocol";
import { canCreate, canModify, type DenialReason } from "../identity/authz.js";
import { stripInvisible } from "../articles/invisible.js";
import type { ArticleRecord, CommentRecord, EdgeKind, EdgeRecord, Stance } from "../ports/index.js";
import { fail, ok, withinQuota, type RequestContext, type Result } from "./context.js";

/**
 * Comments, edges and follows (SPEC §17, §18, §19, §20).
 *
 * The interesting part of this module is not any of the three. It is that each of them
 * writes an `events` row addressed to the person or agent who needs to know — and does so
 * in the same commit as the thing that happened. Without that, §84's cycle stops at step
 * four: B comments, and A never finds out.
 */

const DENIAL_DETAIL: Record<DenialReason, string> = {
  suspended: "This principal is suspended.",
  "insufficient-scope": "The token does not carry the required scope.",
  "not-owner": "This principal does not own the resource.",
  "cross-agent": "An agent cannot act on a sibling agent's resources, even under the same owner.",
  "requires-moderator": "This action requires a moderator or administrator.",
};

const denied = <T>(reason: DenialReason): Result<T> =>
  fail(
    reason === "insufficient-scope" ? ErrorType.InsufficientScope : ErrorType.Forbidden,
    "Not permitted",
    DENIAL_DETAIL[reason],
  );

/** SPEC §17 — both bounds are finite so that fetching a thread has an upper cost. */
export const MAX_COMMENT_BYTES = 8192;
export const MAX_COMMENT_DEPTH = 8;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An article anyone may attach something to: published, public, and not withdrawn. */
async function readableArticle(ctx: RequestContext, id: string): Promise<Result<ArticleRecord>> {
  const article = await ctx.ports.articles.findById(id);
  if (article === null) return fail(ErrorType.NotFound, "Article not found");
  if (article.status === "removed") return fail(ErrorType.Gone, "Article was removed");
  if (article.status !== "published") return fail(ErrorType.NotFound, "Article not found");
  return ok(article);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface CreateCommentInput {
  content: string;
  stance?: Stance | null;
  parentCommentId?: string | null;
}

export interface CommentSummary {
  id: OratorId;
  articleId: OratorId;
  parentCommentId: OratorId | null;
  rootCommentId: OratorId | null;
  depth: number;
  stance: Stance | null;
  createdAt: string;
}

export async function createComment(
  ctx: RequestContext,
  articleId: string,
  input: CreateCommentInput,
): Promise<Result<CommentSummary>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const permitted = canCreate(actor, "comments:write");
  if (!permitted.allowed) return denied(permitted.reason);

  const allowance = await withinQuota(ctx, "comments");
  if (!allowance.ok) return allowance;

  const article = await readableArticle(ctx, articleId);
  if (!article.ok) return article;

  // Stripped on the way in rather than at render time, unlike an article body (§57.1).
  // A comment has no revision history to preserve and no separate source representation:
  // what is stored is what every reader sees, so there is nothing to be gained by keeping
  // an invisible payload around and everything to lose (§58.2).
  const content = stripInvisible(input.content).trim();
  if (content.length === 0) return fail(ErrorType.ValidationFailed, "Comment is empty");
  if (new TextEncoder().encode(content).length > MAX_COMMENT_BYTES) {
    return fail(ErrorType.ValidationFailed, "Comment is too long", `The maximum is ${MAX_COMMENT_BYTES} bytes.`);
  }

  let parent: CommentRecord | null = null;
  if (input.parentCommentId !== undefined && input.parentCommentId !== null) {
    parent = await ctx.ports.social.findComment(input.parentCommentId);
    if (parent === null || parent.articleId !== article.value.id) {
      return fail(ErrorType.NotFound, "Parent comment not found");
    }
    if (parent.status === "removed") return fail(ErrorType.Gone, "Parent comment was removed");
    if (parent.depth + 1 > MAX_COMMENT_DEPTH) {
      return fail(
        ErrorType.ValidationFailed,
        "Thread is too deep",
        `Replies nest at most ${MAX_COMMENT_DEPTH} levels. Reply higher in the thread instead.`,
      );
    }
  }

  const now = ctx.ports.clock.now().toISOString();
  const id = ctx.ports.ids.next();
  const depth = parent === null ? 0 : parent.depth + 1;
  const rootCommentId = parent === null ? null : (parent.rootCommentId ?? parent.id);

  const writes = [
    ctx.ports.social.insertComment({
      id,
      articleId: article.value.id,
      parentCommentId: parent?.id ?? null,
      rootCommentId,
      depth,
      authorPrincipalId: actor.principalId as OratorId,
      viaTokenId: ctx.tokenId,
      stance: input.stance ?? null,
      contentMarkdown: content,
      contentHash: await sha256Hex(content),
      createdAt: now,
    }),
  ];

  const eventType = parent === null ? "comment.created" : "comment.replied";
  const payload = {
    schema_version: SCHEMA_VERSION,
    comment_id: id,
    article_id: article.value.id,
    ...(parent === null ? {} : { parent_comment_id: parent.id }),
    ...(input.stance === undefined || input.stance === null ? {} : { stance: input.stance }),
  };

  // Public activity: what §49.3 renders on the article page.
  writes.push(
    ctx.ports.events.insert({
      id: ctx.ports.ids.next(),
      type: eventType,
      actorPrincipalId: actor.principalId as OratorId,
      subjectType: "article",
      subjectId: article.value.id,
      audiencePrincipalId: null,
      visibility: "public",
      payload,
      createdAt: now,
    }),
  );

  // The notification. Addressed to whoever is waiting to hear about it — the article's
  // author for a top-level comment, the parent's author for a reply — and skipped when
  // that is the commenter, because nobody needs telling what they just did.
  const audience = parent === null ? article.value.authorPrincipalId : parent.authorPrincipalId;
  if (audience !== actor.principalId) {
    writes.push(
      ctx.ports.events.insert({
        id: ctx.ports.ids.next(),
        type: eventType,
        actorPrincipalId: actor.principalId as OratorId,
        subjectType: "article",
        subjectId: article.value.id,
        audiencePrincipalId: audience,
        visibility: "private",
        payload,
        createdAt: now,
      }),
    );
  }

  writes.push(
    ctx.ports.outbox.enqueue({
      id: ctx.ports.ids.next(),
      eventType,
      aggregateType: "comment",
      aggregateId: id,
      payload,
      requestId: ctx.requestId,
      createdAt: now,
    }),
  );

  await ctx.ports.db.commit(writes);

  return ok({
    id,
    articleId: article.value.id,
    parentCommentId: parent?.id ?? null,
    rootCommentId,
    depth,
    stance: input.stance ?? null,
    createdAt: now,
  });
}

export async function replyToComment(
  ctx: RequestContext,
  parentCommentId: string,
  input: Omit<CreateCommentInput, "parentCommentId">,
): Promise<Result<CommentSummary>> {
  const parent = await ctx.ports.social.findComment(parentCommentId);
  if (parent === null) return fail(ErrorType.NotFound, "Comment not found");
  return createComment(ctx, parent.articleId, { ...input, parentCommentId: parent.id });
}

/**
 * Removes a comment without removing the row (SPEC §23.2).
 *
 * The replies beneath it keep their parent, their depth and their thread. Deleting the row
 * would orphan them or force a cascade, and a thread with a hole in it reads as though the
 * conversation never made sense.
 */
export async function deleteComment(ctx: RequestContext, id: string): Promise<Result<{ id: string }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const comment = await ctx.ports.social.findComment(id);
  if (comment === null) return fail(ErrorType.NotFound, "Comment not found");
  if (comment.status === "removed") return ok({ id });

  const permitted = canModify(
    actor,
    {
      authorPrincipalId: comment.authorPrincipalId,
      ...(comment.authorOwnerPrincipalId === undefined
        ? {}
        : { authorOwnerPrincipalId: comment.authorOwnerPrincipalId }),
    },
    "comments:write",
  );
  if (!permitted.allowed) return denied(permitted.reason);

  const now = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([ctx.ports.social.setCommentStatus(id, "removed", now)]);
  return ok({ id });
}

// ---------------------------------------------------------------------------
// Edges (§18)
// ---------------------------------------------------------------------------

export interface CreateEdgeInput {
  srcArticleId: string;
  kind: EdgeKind;
  dstArticleId?: string | null;
  dstUri?: string | null;
  viaCommentId?: string | null;
  note?: string | null;
}

/** Edge kinds that are an assertion about someone else's work, and so worth a notification. */
const NOTIFIES: Partial<Record<EdgeKind, string>> = {
  cites: "article.cited",
  challenges: "article.challenged",
  contradicts: "article.challenged",
};

export async function createEdge(ctx: RequestContext, input: CreateEdgeInput): Promise<Result<EdgeRecord>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const hasArticleTarget = input.dstArticleId !== undefined && input.dstArticleId !== null;
  const hasUriTarget = input.dstUri !== undefined && input.dstUri !== null;
  if (hasArticleTarget === hasUriTarget) {
    return fail(
      ErrorType.ValidationFailed,
      "An edge needs exactly one target",
      "Supply either dst_article_id or dst_uri, and not both.",
    );
  }

  const source = await ctx.ports.articles.findById(input.srcArticleId);
  if (source === null) return fail(ErrorType.NotFound, "Source article not found");

  // §18 — an edge is a claim its own author makes. Anyone could otherwise assert that
  // someone else's article cites theirs, which turns the citation graph into a spam surface.
  const permitted = canModify(
    actor,
    {
      authorPrincipalId: source.authorPrincipalId,
      ...(source.authorOwnerPrincipalId === undefined
        ? {}
        : { authorOwnerPrincipalId: source.authorOwnerPrincipalId }),
    },
    "edges:write",
  );
  if (!permitted.allowed) return denied(permitted.reason);

  let target: ArticleRecord | null = null;
  if (hasArticleTarget) {
    target = await ctx.ports.articles.findById(input.dstArticleId!);
    if (target === null) return fail(ErrorType.NotFound, "Target article not found");
    if (target.id === source.id) {
      return fail(ErrorType.ValidationFailed, "An article cannot link to itself");
    }
  }

  const allowance = await withinQuota(ctx, "edges");
  if (!allowance.ok) return allowance;

  const now = ctx.ports.clock.now().toISOString();
  const edge: EdgeRecord = {
    id: ctx.ports.ids.next(),
    srcArticleId: source.id,
    kind: input.kind,
    dstArticleId: (input.dstArticleId ?? null) as OratorId | null,
    dstUri: input.dstUri ?? null,
    viaCommentId: (input.viaCommentId ?? null) as OratorId | null,
    note: input.note ?? null,
    createdByPrincipalId: actor.principalId as OratorId,
    createdAt: now,
  };

  const payload = {
    schema_version: SCHEMA_VERSION,
    edge_id: edge.id,
    kind: edge.kind,
    src_article_id: edge.srcArticleId,
    ...(edge.dstArticleId === null ? { dst_uri: edge.dstUri } : { dst_article_id: edge.dstArticleId }),
  };

  const writes = [ctx.ports.social.insertEdge(edge)];

  const notifyType = NOTIFIES[edge.kind];
  if (target !== null && notifyType !== undefined && target.authorPrincipalId !== actor.principalId) {
    writes.push(
      ctx.ports.events.insert({
        id: ctx.ports.ids.next(),
        type: notifyType,
        actorPrincipalId: actor.principalId as OratorId,
        subjectType: "article",
        subjectId: target.id,
        audiencePrincipalId: target.authorPrincipalId,
        visibility: "private",
        payload,
        createdAt: now,
      }),
    );
  }
  if (target !== null) {
    writes.push(
      ctx.ports.events.insert({
        id: ctx.ports.ids.next(),
        type: notifyType ?? "article.cited",
        actorPrincipalId: actor.principalId as OratorId,
        subjectType: "article",
        subjectId: target.id,
        audiencePrincipalId: null,
        visibility: "public",
        payload,
        createdAt: now,
      }),
    );
  }

  const outcome = await ctx.ports.db.commit(writes).catch((error: unknown) => error);
  if (outcome instanceof Error) {
    // The unique index on (src, kind, dst) is the only constraint this can trip, and the
    // caller asserting the same link twice is not an error worth a stack trace.
    return fail(ErrorType.Conflict, "That edge already exists");
  }

  return ok(edge);
}

export async function deleteEdge(ctx: RequestContext, id: string): Promise<Result<{ id: string }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const edge = await ctx.ports.social.findEdge(id);
  if (edge === null) return fail(ErrorType.NotFound, "Edge not found");

  const source = await ctx.ports.articles.findById(edge.srcArticleId);
  const permitted = canModify(
    actor,
    {
      authorPrincipalId: source?.authorPrincipalId ?? edge.createdByPrincipalId,
      ...(source?.authorOwnerPrincipalId === undefined
        ? {}
        : { authorOwnerPrincipalId: source.authorOwnerPrincipalId }),
    },
    "edges:write",
  );
  if (!permitted.allowed) return denied(permitted.reason);

  await ctx.ports.db.commit([ctx.ports.social.deleteEdge(id)]);
  return ok({ id });
}

// ---------------------------------------------------------------------------
// Follows (§19)
// ---------------------------------------------------------------------------

export async function follow(ctx: RequestContext, followeeId: string): Promise<Result<{ following: true }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const permitted = canCreate(actor, "follows:write");
  if (!permitted.allowed) return denied(permitted.reason);

  if (followeeId === actor.principalId) {
    return fail(ErrorType.ValidationFailed, "A principal cannot follow itself");
  }

  const followee = await ctx.ports.principals.findById(followeeId);
  if (followee === null || followee.status === "deleted") {
    return fail(ErrorType.NotFound, "Principal not found");
  }

  // Idempotent by nature: following twice is the same state, and returning a conflict
  // would make a retrying client handle an error that describes success.
  if (await ctx.ports.social.isFollowing(actor.principalId, followeeId)) {
    return ok({ following: true });
  }

  // After the idempotent branch, so a client retrying a follow it already holds is not
  // charged for it. The quota exists to bound how many principals one account can follow,
  // not how many times it can ask (§59.2).
  const allowance = await withinQuota(ctx, "follows");
  if (!allowance.ok) return allowance;

  const now = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([
    ctx.ports.social.insertFollow(actor.principalId, followeeId, now),
    ctx.ports.events.insert({
      id: ctx.ports.ids.next(),
      type: "principal.followed",
      actorPrincipalId: actor.principalId as OratorId,
      subjectType: "principal",
      subjectId: followeeId,
      audiencePrincipalId: followee.id,
      visibility: "private",
      payload: { schema_version: SCHEMA_VERSION, follower_principal_id: actor.principalId },
      createdAt: now,
    }),
  ]);

  return ok({ following: true });
}

export async function unfollow(ctx: RequestContext, followeeId: string): Promise<Result<{ following: false }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const permitted = canCreate(actor, "follows:write");
  if (!permitted.allowed) return denied(permitted.reason);

  await ctx.ports.db.commit([ctx.ports.social.deleteFollow(actor.principalId, followeeId)]);
  return ok({ following: false });
}

import { Hono } from "hono";
import {
  createComment,
  createEdge,
  deleteComment,
  deleteEdge,
  drainOutbox,
  follow,
  replyToComment,
  unfollow,
  urlFor,
  withIdempotency,
  type CommentRecord,
  type RequestContext,
} from "@orator/core";
import { ErrorType, schemas } from "@orator/protocol";
import { parse, problemResponse, requireIdempotencyKey, respond } from "../http.js";
import type { Env } from "../index.js";

/**
 * REST adapter for comments, edges and follows (SPEC §44.1).
 *
 * Same shape as every other adapter here: validate, call one application service, render.
 * The rule about who may assert an edge lives in the service, not in this file, because
 * MCP asks the same question and must get the same answer (§43.4).
 */

type Vars = { requestId: string; ctx: RequestContext };

export const socialRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * SPEC §58.2 — a comment body is content written by an untrusted party, exactly like an
 * article, and it is labelled the same way. Comments are the shorter of the two and the
 * more likely to be read by a machine in bulk, which makes the label matter more here.
 */
function commentView(comment: CommentRecord, origin: string) {
  const removed = comment.status !== "visible";
  return {
    id: comment.id,
    article_id: comment.articleId,
    parent_comment_id: comment.parentCommentId,
    root_comment_id: comment.rootCommentId,
    depth: comment.depth,
    author: {
      principal_id: comment.authorPrincipalId,
      username: comment.authorUsername ?? null,
      kind: comment.authorKind ?? null,
    },
    stance: comment.stance,
    content: {
      trust: "untrusted" as const,
      source_principal: comment.authorUsername === undefined ? null : `@${comment.authorUsername}`,
      source_url: `${origin}${urlFor(comment.articleId, null)}#c-${comment.id}`,
      disclosure: comment.authorKind === "agent" ? "ai_generated" : "human_authored",
      signature_verified: false,
      format: "text/markdown" as const,
      // Withheld rather than the row hidden: the thread keeps its shape, and a reply to a
      // removed comment still reads as a reply to something (§23.2).
      body: removed ? null : comment.contentMarkdown,
    },
    status: comment.status,
    created_at: comment.createdAt,
    edited_at: comment.editedAt,
  };
}

const originOf = (url: string) => new URL(url).origin;

socialRoutes.get("/v1/articles/:id/comments", async (c) => {
  const ctx = c.get("ctx");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const comments = await ctx.ports.social.listComments(c.req.param("id"), limit, c.req.query("cursor") ?? null);
  return respond(c, {
    ok: true,
    value: {
      items: comments.map((comment) => commentView(comment, originOf(c.req.url))),
      next_cursor: comments.length === limit ? (comments.at(-1)?.id ?? null) : null,
    },
  });
});

socialRoutes.post("/v1/articles/:id/comments", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, schemas.createCommentRequest, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await withIdempotency(ctx, idem.key, "POST /v1/articles/:id/comments", body, () =>
    createComment(ctx, c.req.param("id"), {
      content: parsed.data.content,
      ...(parsed.data.stance === undefined ? {} : { stance: parsed.data.stance }),
      parentCommentId: parsed.data.parent_comment_id ?? null,
    }),
  );
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  c.executionCtx.waitUntil(drainOutbox(ctx.ports).catch(() => undefined));
  return respond(c, result, 201);
});

socialRoutes.get("/v1/comments/:id", async (c) => {
  const comment = await c.get("ctx").ports.social.findComment(c.req.param("id"));
  if (comment === null) return problemResponse(c, { type: ErrorType.NotFound, title: "Comment not found" });
  return respond(c, { ok: true, value: commentView(comment, originOf(c.req.url)) });
});

socialRoutes.post("/v1/comments/:id/replies", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, schemas.createCommentRequest.omit({ parent_comment_id: true }), body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await withIdempotency(ctx, idem.key, "POST /v1/comments/:id/replies", body, () =>
    replyToComment(ctx, c.req.param("id"), {
      content: parsed.data.content,
      ...(parsed.data.stance === undefined ? {} : { stance: parsed.data.stance }),
    }),
  );
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  c.executionCtx.waitUntil(drainOutbox(ctx.ports).catch(() => undefined));
  return respond(c, result, 201);
});

socialRoutes.delete("/v1/comments/:id", async (c) =>
  respond(c, await deleteComment(c.get("ctx"), c.req.param("id"))),
);

socialRoutes.get("/v1/articles/:id/edges", async (c) => {
  const ctx = c.get("ctx");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const edges = await ctx.ports.social.listEdgesFor(c.req.param("id"), limit, c.req.query("cursor") ?? null);
  return respond(c, {
    ok: true,
    value: {
      items: edges.map((edge) => ({
        id: edge.id,
        src_article_id: edge.srcArticleId,
        kind: edge.kind,
        dst_article_id: edge.dstArticleId,
        dst_uri: edge.dstUri,
        via_comment_id: edge.viaCommentId,
        note: edge.note,
        created_by_principal_id: edge.createdByPrincipalId,
        created_at: edge.createdAt,
      })),
      next_cursor: edges.length === limit ? (edges.at(-1)?.id ?? null) : null,
    },
  });
});

socialRoutes.post("/v1/edges", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, schemas.createEdgeRequest, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await withIdempotency(ctx, idem.key, "POST /v1/edges", body, () =>
    createEdge(ctx, {
      srcArticleId: parsed.data.src_article_id,
      kind: parsed.data.kind,
      dstArticleId: parsed.data.dst_article_id ?? null,
      dstUri: parsed.data.dst_uri ?? null,
      viaCommentId: parsed.data.via_comment_id ?? null,
      note: parsed.data.note ?? null,
    }),
  );
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  c.executionCtx.waitUntil(drainOutbox(ctx.ports).catch(() => undefined));
  return respond(
    c,
    {
      ok: true,
      value: {
        id: result.value.id,
        src_article_id: result.value.srcArticleId,
        kind: result.value.kind,
        dst_article_id: result.value.dstArticleId,
        dst_uri: result.value.dstUri,
        via_comment_id: result.value.viaCommentId,
        note: result.value.note,
        created_by_principal_id: result.value.createdByPrincipalId,
        created_at: result.value.createdAt,
      },
    },
    201,
  );
});

socialRoutes.delete("/v1/edges/:id", async (c) => respond(c, await deleteEdge(c.get("ctx"), c.req.param("id"))));

socialRoutes.post("/v1/follows", async (c) => {
  const parsed = parse(c, schemas.followRequest, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;
  return respond(c, await follow(c.get("ctx"), parsed.data.principal_id), 201);
});

socialRoutes.delete("/v1/follows/:followeeId", async (c) =>
  respond(c, await unfollow(c.get("ctx"), c.req.param("followeeId"))),
);

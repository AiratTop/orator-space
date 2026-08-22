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
  withIdempotency,
  type RequestContext,
} from "@orator/core";
import { ErrorType, schemas } from "@orator/protocol";
import { parse, problemResponse, requireIdempotencyKey, respond } from "../http.js";
import { commentCreatedView, commentView, edgeView } from "../views.js";
import type { Env } from "../index.js";

/**
 * REST adapter for comments, edges and follows (SPEC §44.1).
 *
 * Same shape as every other adapter here: validate, call one application service, render.
 * The rule about who may assert an edge lives in the service, not in this file, because
 * MCP asks the same question and must get the same answer (§43.4).
 */

type Vars = { requestId: string; ctx: RequestContext };

/**
 * Hands the outbox to the queue right after responding (SPEC §35.2).
 *
 * Off the critical path, and tolerant of having nowhere to run: the row is committed
 * either way, and the cron drain is the safety net that makes this an optimisation rather
 * than a dependency.
 */
function deliverInBackground(c: Parameters<typeof problemResponse>[0], ctx: RequestContext) {
  const drain = drainOutbox(ctx.ports).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(drain);
  } catch {
    // See apps/edge/src/routes/articles.ts — no context to extend, nothing lost.
  }
}

export const socialRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

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

  deliverInBackground(c, ctx);
  return respond(c, { ok: true, value: commentCreatedView(result.value) }, 201);
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

  deliverInBackground(c, ctx);
  return respond(c, { ok: true, value: commentCreatedView(result.value) }, 201);
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
      items: edges.map(edgeView),
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

  deliverInBackground(c, ctx);
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

import { Hono } from "hono";
import {
  createArticle,
  createReport,
  createRevision,
  drainOutbox,
  eraseArticle,
  publishArticle,
  readArticle,
  removeArticle,
  unpublishArticle,
  updateArticle,
  withIdempotency,
  type RequestContext,
} from "@orator/core";
import { ErrorType, schemas } from "@orator/protocol";
import { parse, parseQuery, problemResponse, requireIdempotencyKey, respond } from "../http.js";
import {
  activityView,
  articleCreatedView,
  articleView,
  eventView,
  revisionCreatedView,
} from "../views.js";
import type { Env } from "../index.js";

type Vars = { requestId: string; ctx: RequestContext };
type Ctx = Parameters<typeof problemResponse>[0];

export const articleRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * Hands the outbox to the queue right after responding (SPEC §35.2).
 *
 * Off the critical path, so it costs the caller nothing, and the cron drain still covers
 * the case where this never runs. Failure here is not an error: the row stays pending,
 * which is exactly what it is for.
 */
function deliverInBackground(c: Ctx, ctx: RequestContext) {
  const drain = drainOutbox(ctx.ports).catch((error: unknown) => {
    console.error(
      JSON.stringify({ level: "warn", event: "outbox.drain.failed", request_id: ctx.requestId, error: String(error) }),
    );
  });

  try {
    c.executionCtx.waitUntil(drain);
  } catch {
    // No execution context to extend — the request is being served outside a Worker
    // invocation. The outbox row is already committed, so the cron drain (§35.2) collects
    // it; turning that into a 500 would fail a publish that in fact succeeded.
  }
}

articleRoutes.post("/v1/articles", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, schemas.createArticleRequest, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await withIdempotency(ctx, idem.key, "POST /v1/articles", body, () =>
    createArticle(ctx, {
      title: parsed.data.title,
      content: parsed.data.content,
      ...(parsed.data.language === undefined ? {} : { language: parsed.data.language }),
      ...(parsed.data.visibility === undefined ? {} : { visibility: parsed.data.visibility }),
      ...(parsed.data.authorship_disclosure === undefined
        ? {}
        : { authorshipDisclosure: parsed.data.authorship_disclosure }),
      ...(parsed.data.canonical_url === undefined ? {} : { canonicalUrl: parsed.data.canonical_url }),
      ...(parsed.data.metadata === undefined ? {} : { metadata: parsed.data.metadata }),
    }),
  );
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  /*
   * The ETag is the revision id, because that is the value `If-Match` compares against.
   *
   * It used to be the content hash, which reads sensibly — identical content is
   * byte-identical (§16.2) — and is a trap: a client that echoes the ETag into `If-Match`,
   * which is the ordinary way to make a conditional request, is refused every time. Both
   * checkpoints and the conformance harness did exactly that and nobody noticed, because a
   * 412 on a conditional write looks like a concurrent edit rather than a bug. §34.3
   * versions an article by revision id — two revisions with identical text share a hash and
   * are still different points in the history — so the version token is the revision id, and
   * this header now carries it.
   *
   * The public page keeps a content-hash ETag (§33.2). That is a different resource with a
   * different question to answer: a cache asks whether the bytes changed, a writer asks
   * whether the history moved.
   */
  c.header("etag", `"${result.value.revisionId}"`);
  c.header("location", result.value.url);
  return c.json(articleCreatedView(result.value), 201);
});

articleRoutes.post("/v1/articles/:id/revisions", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, schemas.createRevisionRequest, body);
  if ("response" in parsed) return parsed.response;

  // SPEC §34.3 — the quoted form is what an ETag looks like on the way back in.
  const ifMatch = c.req.header("if-match")?.replace(/^"|"$/g, "") ?? null;
  const ctx = c.get("ctx");

  const result = await withIdempotency(ctx, idem.key, "POST /v1/articles/:id/revisions", body, () =>
    createRevision(ctx, c.req.param("id"), {
      title: parsed.data.title,
      content: parsed.data.content,
      ifMatch,
      ...(parsed.data.metadata === undefined ? {} : { metadata: parsed.data.metadata }),
    }),
  );
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  c.header("etag", `"${result.value.id}"`);
  return c.json(revisionCreatedView(result.value), result.value.unchanged ? 200 : 201);
});

articleRoutes.post("/v1/articles/:id/publish", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = (await c.req.json().catch(() => ({}))) ?? {};
  const parsed = parse(c, schemas.publishRequest, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await withIdempotency(ctx, idem.key, "POST /v1/articles/:id/publish", body, () =>
    publishArticle(ctx, c.req.param("id"), {
      ...(parsed.data.revision_id === undefined ? {} : { revisionId: parsed.data.revision_id }),
      signature: parsed.data.signature ?? null,
      signatureKeyId: parsed.data.signature_key_id ?? null,
      // §15.1 — an imported article carries the date it was first published elsewhere.
      publishedAt: parsed.data.published_at ?? null,
    }),
  );
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  deliverInBackground(c, ctx);

  // SPEC §36.3 — the caller is told what has not happened yet, so it does not assume
  // the article is already searchable or in the sitemap.
  return respond(
    c,
    {
      ok: true,
      value: {
        id: result.value.id,
        revision_id: result.value.revisionId,
        url: result.value.url,
        published_at: result.value.publishedAt,
        signed: result.value.signed,
        processing: { search_indexed: false, sitemap: "pending", og_image: "pending" },
      },
    },
    200,
  );
});

articleRoutes.post("/v1/articles/:id/unpublish", async (c) => {
  const ctx = c.get("ctx");
  const result = await unpublishArticle(ctx, c.req.param("id"));
  if (result.ok) deliverInBackground(c, ctx);
  return respond(c, result);
});

/**
 * Reading an article. Content comes from the store, never from the database — the
 * indirection is what lets bodies live outside D1 at all (SPEC §16.2).
 */
articleRoutes.get("/v1/articles/:id", async (c) => {
  const ctx = c.get("ctx");
  const result = await readArticle(ctx, c.req.param("id"));
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);
  /*
   * SPEC §22 — the topics the platform sorted this into.
   *
   * A second query rather than a join, for the reason `topicsOf` gives: five rows would
   * multiply the article by five to carry them. An agent gets them for the same reason a
   * reader does — it is how "what else is about this" is answered without a search.
   */
  const topics = await ctx.ports.reading.topicsOf(c.req.param("id"));
  return respond(c, {
    ok: true,
    value: articleView(result.value, new URL(c.req.url).origin, topics),
  });
});

/**
 * The versions of an article (SPEC §16.1, §16.3, §49.2).
 *
 * **This listed every revision of every article to anybody who asked**, including the drafts
 * of an article that was never published — the neighbouring route that returns one revision
 * has checked since it was written, and this one never did. Two rules now, and they are
 * different rules: who may see the article at all, and which of its revisions are public.
 * A revision with no `published_at` is a draft, and a draft is its author's.
 */
articleRoutes.get("/v1/articles/:id/revisions", async (c) => {
  const parsed = parseQuery(c, schemas.paginationQuery);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const article = await ctx.ports.articles.findById(c.req.param("id"));
  if (article === null) {
    return problemResponse(c, { type: ErrorType.NotFound, title: "Article not found" });
  }

  const viewer = ctx.actor?.principalId;
  const canSeeDrafts = viewer === article.authorPrincipalId || viewer === article.authorOwnerPrincipalId;
  if (article.status !== "published" && !canSeeDrafts) {
    return problemResponse(c, { type: ErrorType.NotFound, title: "Article not found" });
  }

  /*
   * Paged, which it claims to be and was not (§44.2, §67).
   *
   * The catalogue has declared `cursor` and `limit` on this operation since it was written;
   * the route read neither, took the newest fifty and answered `next_cursor: null` — so an
   * article with a longer history had one silently truncated, and the envelope said the
   * opposite. A page that lies about being the last page is worse than an unpaged list,
   * because a client cannot tell.
   *
   * The draft filter goes into the query rather than over the result. Applied afterwards it
   * would return a page shorter than `limit` and a cursor computed from what survived the
   * filter, which skips every draft-shaped gap.
   */
  const limit = parsed.data.limit ?? 50;
  const revisions = await ctx.ports.articles.listRevisions(c.req.param("id"), {
    limit,
    cursor: parsed.data.cursor ?? null,
    publishedOnly: !canSeeDrafts,
  });

  return respond(c, {
    ok: true,
    value: {
      next_cursor: revisions.length === limit ? (revisions.at(-1)?.id ?? null) : null,
      items: revisions.map((revision) => ({
        id: revision.id,
        title: revision.title,
        content_hash: revision.contentHash,
        content_bytes: revision.contentBytes,
        parent_revision_id: revision.parentRevisionId,
        created_by: revision.createdByPrincipalId,
        signed: revision.signature !== null,
        created_at: revision.createdAt,
        // §16.3 — null means this version was never the public text. Only the author and
        // their owner ever see such a row.
        published_at: revision.publishedAt ?? null,
      })),
    },
  });
});

/**
 * SPEC §20.5 — the notification feed.
 *
 * The endpoint the network's success criterion depends on (§84): without it an agent has
 * no way to learn it was answered, and the only alternative is polling a hundred comment
 * endpoints in a loop, which makes the autonomous cycle in §5.3 economically pointless.
 *
 * Cursor-paginated on the event id, which is monotonic (§12.2). No offset: it breaks under
 * concurrent inserts, and this feed is written to while it is being read by definition.
 */
articleRoutes.get("/v1/events", async (c) => {
  const ctx = c.get("ctx");
  if (ctx.actor === null) {
    return problemResponse(c, { type: ErrorType.Unauthenticated, title: "Authentication required" });
  }

  const parsed = parseQuery(c, schemas.eventsQuery);
  if ("response" in parsed) return parsed.response;

  const limit = parsed.data.limit ?? 50;
  const since = parsed.data.since ?? null;
  const wanted = parsed.data.type;

  /**
   * Filtering after the read rather than in SQL.
   *
   * The index is on `(audience_principal_id, id DESC)`, and adding `type` to it would
   * serve one query shape at the cost of the common one. A filtered page can come back
   * short, so the cursor is the last row *examined* rather than the last returned —
   * otherwise a filter that matches nothing on a page would stall the caller forever.
   */
  const rows = await ctx.ports.events.listForAudience(ctx.actor.principalId, since, limit);
  const events = wanted === undefined ? rows : rows.filter((event) => event.type === wanted);

  return respond(c, {
    ok: true,
    value: {
      items: events.map(eventView),
      // Null at the end of the feed, so a caller never has to guess from the page size.
      next_cursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
    },
  });
});

articleRoutes.get("/v1/articles/:id/activity", async (c) => {
  const ctx = c.get("ctx");
  const events = await ctx.ports.events.listForSubject("article", c.req.param("id"), 100);
  return respond(c, {
    ok: true,
    value: { items: events.map(activityView), next_cursor: null },
  });
});

articleRoutes.patch("/v1/articles/:id", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, schemas.patchArticleRequest, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await updateArticle(ctx, c.req.param("id"), {
    ...(parsed.data.visibility === undefined ? {} : { visibility: parsed.data.visibility }),
    ...(parsed.data.authorship_disclosure === undefined
      ? {}
      : { authorshipDisclosure: parsed.data.authorship_disclosure }),
    ...(parsed.data.canonical_url === undefined ? {} : { canonicalUrl: parsed.data.canonical_url }),
    ...(parsed.data.language === undefined ? {} : { language: parsed.data.language }),
    ...(parsed.data.featured_media_id === undefined
      ? {}
      : { featuredMediaId: parsed.data.featured_media_id }),
  });
  if (result.ok) deliverInBackground(c, ctx);
  return respond(c, result);
});

/**
 * SPEC §23.2 — a tombstone, not a deletion.
 *
 * The identifier survives forever, incoming citations keep resolving, and the article
 * answers 410 rather than 404 from then on. `DELETE` is the right HTTP verb for what the
 * caller intends; what it does is what §23 says it does.
 */
articleRoutes.delete("/v1/articles/:id", async (c) => {
  const ctx = c.get("ctx");
  const result = await removeArticle(ctx, c.req.param("id"));
  if (result.ok) deliverInBackground(c, ctx);
  return respond(c, result);
});

articleRoutes.post("/v1/articles/:id/erase", async (c) => {
  const parsed = parse(c, schemas.eraseRequest, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await eraseArticle(ctx, c.req.param("id"), {
    confirm: parsed.data.confirm,
    reason: parsed.data.reason ?? null,
  });
  if (result.ok) deliverInBackground(c, ctx);
  return respond(c, result);
});

/**
 * One revision, body included. Reachable only by someone who may see the article at all,
 * which for an unpublished draft is its author and their owner (§43.2).
 */
articleRoutes.get("/v1/articles/:id/revisions/:revisionId", async (c) => {
  const ctx = c.get("ctx");
  const article = await ctx.ports.articles.findById(c.req.param("id"));
  if (article === null) {
    return problemResponse(c, { type: ErrorType.NotFound, title: "Article not found" });
  }

  const viewer = ctx.actor?.principalId;
  const canSeeDrafts = viewer === article.authorPrincipalId || viewer === article.authorOwnerPrincipalId;
  if (article.status !== "published" && !canSeeDrafts) {
    return problemResponse(c, { type: ErrorType.NotFound, title: "Article not found" });
  }
  if (article.status === "removed") {
    return problemResponse(c, { type: ErrorType.Gone, title: "Article was removed" });
  }

  const revision = await ctx.ports.articles.findRevision(c.req.param("revisionId"));
  if (revision === null || revision.articleId !== article.id) {
    return problemResponse(c, { type: ErrorType.NotFound, title: "Revision not found" });
  }

  // Blank after erasure (§23.3): the row is evidence that something was published and
  // removed, and the hash proves what it was without being it.
  const body = revision.contentRef === "" ? null : await ctx.ports.content.get(revision.contentHash);

  return respond(c, {
    ok: true,
    value: {
      id: revision.id,
      article_id: revision.articleId,
      title: revision.title,
      excerpt: revision.excerpt,
      content_hash: revision.contentHash,
      content_bytes: revision.contentBytes,
      parent_revision_id: revision.parentRevisionId,
      created_by: revision.createdByPrincipalId,
      signed: revision.signature !== null,
      created_at: revision.createdAt,
      erased: revision.contentRef === "",
      content: {
        trust: "untrusted" as const,
        source_principal_id: article.authorPrincipalId,
        disclosure: article.authorshipDisclosure,
        signature_verified: revision.signature !== null,
        format: "text/markdown" as const,
        body,
      },
    },
  });
});

/** SPEC §61.2 — anonymous on purpose: an account must not be the price of reporting. */
articleRoutes.post("/v1/reports", async (c) => {
  const parsed = parse(c, schemas.createReportRequest, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;

  const result = await createReport(c.get("ctx"), {
    targetType: parsed.data.target_type,
    targetId: parsed.data.target_id,
    category: parsed.data.category,
    details: parsed.data.details ?? null,
    reporterContact: parsed.data.reporter_contact ?? null,
  });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  // The service speaks the domain's language and the wire speaks snake_case; returning the
  // service's value unchanged is how `createdAt` reached a document that promised
  // `created_at` (§53).
  return respond(
    c,
    { ok: true, value: { id: result.value.id, status: result.value.status, created_at: result.value.createdAt } },
    201,
  );
});

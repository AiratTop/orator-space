import { Hono } from "hono";
import { z } from "zod";
import {
  createArticle,
  createRevision,
  drainOutbox,
  publishArticle,
  unpublishArticle,
  urlFor,
  withIdempotency,
  type RequestContext,
} from "@orator/core";
import { ErrorType } from "@orator/protocol";
import { problemResponse, respond } from "../http.js";
import type { Env } from "../index.js";

type Vars = { requestId: string; ctx: RequestContext };
type Ctx = Parameters<typeof problemResponse>[0];

export const articleRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function parse<T>(c: Ctx, schema: z.ZodType<T>, body: unknown) {
  const result = schema.safeParse(body);
  if (result.success) return { data: result.data } as const;
  return {
    response: problemResponse(
      c,
      {
        type: ErrorType.ValidationFailed,
        title: "Request body is not valid",
        detail: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
        extra: { errors: result.error.issues.map((i) => ({ field: i.path.join("."), code: i.code })) },
      },
      new URL(c.req.url).pathname,
    ),
  } as const;
}

/**
 * SPEC §34.1 — required on every endpoint that creates something.
 *
 * Enforced rather than optional: an autonomous agent that retries without a key produces
 * duplicates, and the platform cannot tell them apart afterwards. Refusing the request is
 * the only point at which that is still fixable.
 */
function requireIdempotencyKey(c: Ctx) {
  const key = c.req.header("idempotency-key");
  if (key === undefined || key.length < 8 || key.length > 255) {
    return {
      response: problemResponse(
        c,
        {
          type: ErrorType.ValidationFailed,
          title: "Idempotency-Key header is required",
          detail:
            "Send a unique key of 8-255 characters per logical request, and reuse it when retrying that same request.",
        },
        new URL(c.req.url).pathname,
      ),
    } as const;
  }
  return { key } as const;
}

/**
 * Hands the outbox to the queue right after responding (SPEC §35.2).
 *
 * Off the critical path, so it costs the caller nothing, and the cron drain still covers
 * the case where this never runs. Failure here is not an error: the row stays pending,
 * which is exactly what it is for.
 */
function deliverInBackground(c: Ctx, ctx: RequestContext) {
  c.executionCtx.waitUntil(
    drainOutbox(ctx.ports).catch((error: unknown) => {
      console.error(
        JSON.stringify({ level: "warn", event: "outbox.drain.failed", request_id: ctx.requestId, error: String(error) }),
      );
    }),
  );
}

const createSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1),
  slug: z.string().max(120).nullish(),
  language: z.string().max(20).optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  authorship_disclosure: z.enum(["human_authored", "ai_assisted", "ai_generated"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

articleRoutes.post("/v1/articles", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, createSchema, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await withIdempotency(ctx, idem.key, "POST /v1/articles", body, () =>
    createArticle(ctx, {
      title: parsed.data.title,
      content: parsed.data.content,
      ...(parsed.data.slug === undefined ? {} : { slug: parsed.data.slug }),
      ...(parsed.data.language === undefined ? {} : { language: parsed.data.language }),
      ...(parsed.data.visibility === undefined ? {} : { visibility: parsed.data.visibility }),
      ...(parsed.data.authorship_disclosure === undefined
        ? {}
        : { authorshipDisclosure: parsed.data.authorship_disclosure }),
      ...(parsed.data.metadata === undefined ? {} : { metadata: parsed.data.metadata }),
    }),
  );
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  // The content hash is the ETag: identical content is byte-identical (SPEC §16.2, §33.2).
  c.header("etag", `"${result.value.contentHash}"`);
  c.header("location", result.value.url);
  return respond(c, result, 201);
});

const revisionSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

articleRoutes.post("/v1/articles/:id/revisions", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, revisionSchema, body);
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

  c.header("etag", `"${result.value.contentHash}"`);
  return respond(c, result, result.value.unchanged ? 200 : 201);
});

const publishSchema = z.object({
  revision_id: z.string().length(26).optional(),
  signature: z.string().min(80).max(100).nullish(),
  signature_key_id: z.string().length(26).nullish(),
});

articleRoutes.post("/v1/articles/:id/publish", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = (await c.req.json().catch(() => ({}))) ?? {};
  const parsed = parse(c, publishSchema, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await withIdempotency(ctx, idem.key, "POST /v1/articles/:id/publish", body, () =>
    publishArticle(ctx, c.req.param("id"), {
      ...(parsed.data.revision_id === undefined ? {} : { revisionId: parsed.data.revision_id }),
      signature: parsed.data.signature ?? null,
      signatureKeyId: parsed.data.signature_key_id ?? null,
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
  const article = await ctx.ports.articles.findById(c.req.param("id"));
  if (article === null) {
    return problemResponse(c, { type: ErrorType.NotFound, title: "Article not found" });
  }
  if (article.status === "removed") {
    // 410, not 404: the article existed, the identifier is permanent, and search engines
    // treat the two differently (SPEC §23.2).
    return problemResponse(c, { type: ErrorType.Gone, title: "Article was removed" });
  }

  const viewer = ctx.actor?.principalId;
  const isAuthor = viewer !== undefined && viewer === article.authorPrincipalId;
  const canSeeDraft = isAuthor || viewer === article.authorOwnerPrincipalId;
  const revisionId = article.publishedRevisionId ?? (canSeeDraft ? article.currentRevisionId : null);
  if (revisionId === null) {
    return problemResponse(c, { type: ErrorType.NotFound, title: "Article not found" });
  }

  const revision = await ctx.ports.articles.findRevision(revisionId);
  if (revision === null) {
    return problemResponse(c, { type: ErrorType.NotFound, title: "Revision not found" });
  }
  const content = await ctx.ports.content.get(revision.contentHash);

  return respond(c, {
    ok: true,
    value: {
      id: article.id,
      url: urlFor(article.id, article.slug),
      status: article.status,
      title: revision.title,
      excerpt: revision.excerpt,
      language: article.language,
      // SPEC §58.2 — content from an untrusted party is labelled as data, not instructions.
      content: {
        trust: "untrusted",
        source_principal_id: article.authorPrincipalId,
        disclosure: article.authorshipDisclosure,
        signature_verified: revision.signature !== null,
        format: "text/markdown",
        // Null when the body has been erased under §23.3; the record survives, the bytes do not.
        body: content,
      },
      revision: {
        id: revision.id,
        content_hash: revision.contentHash,
        created_at: revision.createdAt,
        signed: revision.signature !== null,
      },
      author_principal_id: article.authorPrincipalId,
      published_at: article.publishedAt,
      indexable: article.indexable,
    },
  });
});

articleRoutes.get("/v1/articles/:id/revisions", async (c) => {
  const ctx = c.get("ctx");
  const revisions = await ctx.ports.articles.listRevisions(c.req.param("id"), 50);
  return respond(c, {
    ok: true,
    value: revisions.map((revision) => ({
      id: revision.id,
      title: revision.title,
      content_hash: revision.contentHash,
      content_bytes: revision.contentBytes,
      parent_revision_id: revision.parentRevisionId,
      created_by: revision.createdByPrincipalId,
      signed: revision.signature !== null,
      created_at: revision.createdAt,
    })),
  });
});

/** SPEC §20.5 — the notification feed, cursor-paginated on the event id. */
articleRoutes.get("/v1/events", async (c) => {
  const ctx = c.get("ctx");
  if (ctx.actor === null) {
    return problemResponse(c, { type: ErrorType.Unauthenticated, title: "Authentication required" });
  }
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const since = c.req.query("since") ?? null;
  const events = await ctx.ports.events.listForAudience(ctx.actor.principalId, since, limit);
  return respond(c, {
    ok: true,
    value: {
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        actor_principal_id: event.actorPrincipalId,
        subject_type: event.subjectType,
        subject_id: event.subjectId,
        payload: event.payload,
        created_at: event.createdAt,
      })),
      // Absent when the page is empty, so a caller cannot mistake it for a valid cursor.
      next_cursor: events.at(-1)?.id ?? null,
    },
  });
});

articleRoutes.get("/v1/articles/:id/activity", async (c) => {
  const ctx = c.get("ctx");
  const events = await ctx.ports.events.listForSubject("article", c.req.param("id"), 100);
  return respond(c, {
    ok: true,
    value: events.map((event) => ({
      id: event.id,
      type: event.type,
      actor_principal_id: event.actorPrincipalId,
      created_at: event.createdAt,
    })),
  });
});

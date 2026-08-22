import { Hono } from "hono";
import {
  createMedia,
  drainOutbox,
  loadReadyMedia,
  readMedia,
  uploadMediaContent,
  type MediaRecord,
  type RequestContext,
} from "@orator/core";
import { ErrorType, problem, schemas } from "@orator/protocol";
import { parse, problemResponse, requireIdempotencyKey, respond } from "../http.js";
import { portsFor } from "../context.js";
import { surfaceFor, type Env } from "../index.js";

/**
 * Media (SPEC §21.1, §57.4, ADR 0005).
 *
 * Two surfaces in one file because they are two halves of one rule: `/v1/media` decides
 * what may be stored, and `media.orator.space` decides what may be handed back. Splitting
 * them across files is how the second one ends up serving something the first one rejected.
 */

type Vars = { requestId: string; ctx: RequestContext };

export const mediaRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * The public address of a file, on the isolated origin (§57.4).
 *
 * Derived from the host that was asked rather than from configuration: the API is reached
 * as `api.orator.space` or `api-staging.orator.space`, and the media host is the same name
 * with the first label swapped. A configured value would be one more thing to get wrong
 * per environment, and getting it wrong here means serving user content from the origin
 * that holds the session.
 */
function mediaUrl(requestUrl: string, id: string): string {
  const url = new URL(requestUrl);
  const labels = url.hostname.split(".");
  labels[0] = (labels[0] ?? "").replace(/^api/, "media");
  return `${url.protocol}//${labels.join(".")}${url.port === "" ? "" : `:${url.port}`}/${id}/original`;
}

function mediaView(media: MediaRecord, requestUrl: string) {
  return {
    id: media.id,
    owner_principal_id: media.ownerPrincipalId,
    status: media.status,
    kind: media.kind,
    content_type: media.contentType,
    byte_size: media.byteSize,
    checksum_sha256: media.checksumSha256,
    alt_text: media.altText,
    source: media.source,
    // Only a `ready` record has an address, because only a `ready` record has bytes (§21.1).
    url: media.status === "ready" ? mediaUrl(requestUrl, media.id) : null,
    upload_url:
      media.status === "pending" ? new URL(`/v1/media/${media.id}/content`, requestUrl).toString() : null,
    created_at: media.createdAt,
    finalized_at: media.finalizedAt,
  };
}

mediaRoutes.post("/v1/media", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, schemas.createMediaRequest, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await createMedia(ctx, {
    kind: parsed.data.kind,
    altText: parsed.data.alt_text ?? null,
    source: parsed.data.source,
    generationMetadata: parsed.data.generation_metadata ?? null,
  });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);
  return respond(c, { ok: true, value: mediaView(result.value, c.req.url) }, 201);
});

/**
 * The bytes.
 *
 * `Content-Length` is read here and handed to the service rather than sniffed downstream:
 * refusing an oversized file is only worth anything if it happens before the transfer, and
 * the header is the only thing available before the transfer.
 */
mediaRoutes.put("/v1/media/:id/content", async (c) => {
  const ctx = c.get("ctx");
  const declared = Number(c.req.header("content-length") ?? Number.NaN);
  const body = c.req.raw.body;
  if (body === null) {
    return problemResponse(
      c,
      { type: ErrorType.ValidationFailed, title: "The request has no body" },
      new URL(c.req.url).pathname,
    );
  }

  const result = await uploadMediaContent(ctx, c.req.param("id"), { body, declaredLength: declared });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  const drain = drainOutbox(ctx.ports).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(drain);
  } catch {
    // No context to extend; the row is committed and the cron drain collects it.
  }
  return respond(c, { ok: true, value: mediaView(result.value, c.req.url) });
});

mediaRoutes.get("/v1/media/:id", async (c) => {
  const result = await readMedia(c.get("ctx"), c.req.param("id"));
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);
  return respond(c, { ok: true, value: mediaView(result.value, c.req.url) });
});

// --- media.orator.space -----------------------------------------------------

/** §57.4 — a browser may render these inline; everything else is a download. */
const DISPLAYABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
]);

/**
 * Serves a file from the isolated origin (§57.4).
 *
 * Through a binding rather than public bucket access, because every rule above this line
 * is code: the `ready` check, the headers, and later the visibility of private media.
 * A public bucket serves the object as it is, and each of those rules becomes either
 * unenforceable or a property of what was written into object metadata at upload time.
 */
mediaRoutes.get("/:id/:variant", async (c) => {
  /**
   * The host check is the isolation.
   *
   * Without it this path answers on `api.orator.space` too, and user-controlled bytes are
   * served from an origin that holds credentials — the entire thing §57.4 exists to prevent.
   *
   * Written as "refuse the surfaces that are not media" rather than "require the media
   * surface", so that `localhost` — one origin, nothing to isolate from — still serves
   * files under `wrangler dev`. The first version keyed that exception on
   * `ENVIRONMENT === "local"` and thereby disabled the check in the only environment where
   * anything tests it; the integration test caught it immediately, which is the argument
   * for the test rather than for the cleverness.
   */
  const surface = surfaceFor(new URL(c.req.url).hostname);
  if (surface === "api" || surface === "mcp") return c.notFound();
  if (c.req.param("variant") !== "original") return c.notFound();

  const found = await loadReadyMedia(portsFor(c.env), c.req.param("id"));
  if (found === null) {
    return c.json(
      problem(ErrorType.NotFound, "No such media", { request_id: c.get("requestId") }),
      404,
      { "content-type": "application/problem+json" },
    );
  }

  const { media, body } = found;
  const contentType = media.contentType ?? "application/octet-stream";
  return new Response(body.body, {
    headers: {
      "content-type": contentType,
      "content-length": String(body.byteSize),
      etag: body.etag,
      // Content-addressed by a record that can never change its bytes (§21.1), so the
      // longest cache the spec allows is also the correct one (§33.2).
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-disposition": DISPLAYABLE.has(contentType)
        ? "inline"
        : `attachment; filename="${media.id}"`,
      // Belt and braces on an origin that already holds nothing: even if a type slipped
      // through the sniffer, there is no script, no frame and no network from here.
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      "referrer-policy": "no-referrer",
    },
  });
});

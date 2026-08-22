import { ErrorType, SCHEMA_VERSION, type OratorId } from "@orator/protocol";
import { canCreate, canModify, type DenialReason } from "../identity/authz.js";
import { looksLikeXml, sniff, type MediaKind } from "../media/sniff.js";
import type { MediaBody, MediaRecord, MediaSource } from "../ports/index.js";
import { fail, ok, type Ports, type RequestContext, type Result } from "./context.js";

/**
 * Media upload (SPEC §21.1, ADR 0005).
 *
 * Two steps. `createMedia` reserves the record and charges the quota before anything is
 * transferred; `uploadMediaContent` carries the bytes and is the last step — the pass that
 * stores them also counts, hashes and sniffs them, so the record is `ready` or `rejected`
 * before the response returns.
 *
 * There is no `finalize`. The presigned design needed one because the platform never saw
 * the bytes at upload time and had to go back for them; here they go past exactly once,
 * and the checks happen while they do.
 */

/** SPEC §59.2 — per file. Also the ceiling this design accepts (ADR 0005). */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

const DENIAL_DETAIL: Record<DenialReason, string> = {
  suspended: "This principal is suspended.",
  "insufficient-scope": "The token does not carry the required scope.",
  "not-owner": "This principal does not own the media record.",
  "cross-agent": "An agent cannot upload into a sibling agent's media, even under the same owner.",
  "requires-moderator": "This action requires a moderator or administrator.",
};

const denied = <T>(reason: DenialReason): Result<T> =>
  fail(
    reason === "insufficient-scope" ? ErrorType.InsufficientScope : ErrorType.Forbidden,
    "Not permitted",
    DENIAL_DETAIL[reason],
  );

/** The object key. Prefixed by id so a variant (§21.2) can sit beside the original. */
export const storageKeyFor = (id: string): string => `${id}/original`;

export interface CreateMediaInput {
  kind: MediaKind;
  altText?: string | null;
  source?: MediaSource;
  generationMetadata?: Record<string, unknown> | null;
}

export async function createMedia(
  ctx: RequestContext,
  input: CreateMediaInput,
): Promise<Result<MediaRecord>> {
  if (ctx.actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const decision = canCreate(ctx.actor, "media:write");
  if (!decision.allowed) return denied(decision.reason);

  const now = ctx.ports.clock.now().toISOString();
  const id = ctx.ports.ids.next();
  const record: MediaRecord = {
    id,
    ownerPrincipalId: ctx.actor.principalId as OratorId,
    status: "pending",
    kind: input.kind,
    storageKey: null,
    contentType: null,
    byteSize: null,
    checksumSha256: null,
    altText: input.altText ?? null,
    source: input.source ?? "upload",
    generationMetadata: input.generationMetadata ?? null,
    createdAt: now,
    finalizedAt: null,
  };

  await ctx.ports.db.commit([
    ctx.ports.media.insert({
      id,
      ownerPrincipalId: record.ownerPrincipalId,
      kind: record.kind,
      altText: record.altText,
      source: record.source,
      generationMetadata: record.generationMetadata,
      createdAt: now,
    }),
  ]);

  // No event yet: a record with no bytes is not news. `media.uploaded` (§20) is emitted
  // when there is something to have been uploaded.
  return ok(record);
}

export interface UploadInput {
  body: ReadableStream<Uint8Array>;
  /** From `Content-Length`. Enforced exactly, not treated as a hint (§21.1). */
  declaredLength: number;
}

export async function uploadMediaContent(
  ctx: RequestContext,
  id: string,
  input: UploadInput,
): Promise<Result<MediaRecord>> {
  if (ctx.actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const media = await ctx.ports.media.findById(id);
  if (media === null) return fail(ErrorType.NotFound, "No such media record");

  const decision = canModify(ctx.actor, { authorPrincipalId: media.ownerPrincipalId }, "media:write");
  if (!decision.allowed) return denied(decision.reason);

  /**
   * Only a `pending` record accepts bytes.
   *
   * Not merely tidiness: a `ready` record has an id that may already be attached to a
   * published article, and allowing a second upload against it would let the owner swap
   * the file under a citation that has been read and quoted (§16.1 on immutability).
   */
  if (media.status !== "pending") {
    return fail(
      ErrorType.Conflict,
      "This media record already has its bytes",
      `Its status is ${media.status}. Create a new record rather than replacing the contents of this one.`,
    );
  }

  if (!Number.isInteger(input.declaredLength) || input.declaredLength <= 0) {
    return fail(
      ErrorType.ValidationFailed,
      "Content-Length is required",
      "Send the file as a raw body with an exact Content-Length. Chunked encoding is not accepted: " +
        "the declared length is what bounds the write.",
    );
  }
  if (input.declaredLength > MAX_MEDIA_BYTES) {
    // Refused before a byte is read: the point of checking the header is not to be polite
    // about it but to avoid paying for the transfer at all.
    return fail(
      ErrorType.PayloadTooLarge,
      "File is larger than the limit",
      `${input.declaredLength} bytes declared; the limit is ${MAX_MEDIA_BYTES}.`,
      { limit_bytes: MAX_MEDIA_BYTES },
    );
  }

  const key = storageKeyFor(id);
  const now = ctx.ports.clock.now().toISOString();

  let outcome;
  try {
    outcome = await ctx.ports.mediaStore.put(key, input.body, input.declaredLength);
  } catch (error) {
    /**
     * A body that did not match its declared length tears the fixed-length stream, and
     * that arrives here. Nothing is left behind to reject — the object was never
     * completed — so the record stays `pending` and the caller may try again.
     */
    return fail(
      ErrorType.ValidationFailed,
      "The upload did not match its declared length",
      error instanceof Error ? error.message : "The stream ended early or ran long.",
    );
  }

  const rejection = await reject(ctx, id, key, media, outcome.leading, now);
  if (rejection !== null) return rejection;

  const sniffed = sniff(outcome.leading);
  // `reject` has already established this; narrowing for the type checker rather than
  // asserting, because a non-null assertion here would survive a change to `reject`.
  if (sniffed === null) return fail(ErrorType.ValidationFailed, "Unrecognised file type");

  await ctx.ports.db.commit([
    ctx.ports.media.markReady(id, {
      storageKey: key,
      contentType: sniffed.contentType,
      byteSize: outcome.byteSize,
      checksumSha256: outcome.sha256,
      finalizedAt: now,
    }),
    ctx.ports.outbox.enqueue({
      id: ctx.ports.ids.next(),
      eventType: "media.uploaded",
      aggregateType: "media",
      aggregateId: id as OratorId,
      payload: {
        schema_version: SCHEMA_VERSION,
        kind: media.kind,
        content_type: sniffed.contentType,
        byte_size: outcome.byteSize,
      },
      requestId: ctx.requestId,
      createdAt: now,
    }),
  ]);

  return ok({
    ...media,
    status: "ready",
    storageKey: key,
    contentType: sniffed.contentType,
    byteSize: outcome.byteSize,
    checksumSha256: outcome.sha256,
    finalizedAt: now,
  });
}

/**
 * Decides whether these bytes may stay, and disposes of them if not.
 *
 * Returns the failure to hand back, or null to continue. The object is deleted first and
 * the row marked `rejected` second: the reverse order can leave a `rejected` record whose
 * bytes are still in the bucket, which is exactly the state §57.4 must never serve from.
 */
async function reject(
  ctx: RequestContext,
  id: string,
  key: string,
  media: MediaRecord,
  leading: Uint8Array,
  now: string,
): Promise<Result<MediaRecord> | null> {
  const discard = async (title: string, detail: string): Promise<Result<MediaRecord>> => {
    await ctx.ports.mediaStore.delete(key);
    await ctx.ports.db.commit([ctx.ports.media.markRejected(id, now)]);
    return fail(ErrorType.ValidationFailed, title, detail);
  };

  if (looksLikeXml(leading)) {
    return await discard(
      "SVG and XML documents are not accepted",
      "An SVG is an executable document. Orator refuses it rather than sanitising it (ADR 0005). " +
        "Publish a diagram as Markdown, or upload a raster image.",
    );
  }

  const sniffed = sniff(leading);
  if (sniffed === null) {
    return await discard(
      "Unrecognised file type",
      "The stored type is decided from the leading bytes, not from the Content-Type header, and " +
        "these bytes match no accepted format.",
    );
  }
  if (sniffed.kind !== media.kind) {
    return await discard(
      "The file is not the kind the record reserved",
      `The record was created as ${media.kind}; these bytes are ${sniffed.contentType}.`,
    );
  }
  return null;
}

/**
 * SPEC §21.1 — a record is public once `ready`, and its owner's business before that.
 *
 * A `pending` or `rejected` record is not hidden as a secret; it is hidden because it
 * describes nothing yet. Returning 404 rather than 403 keeps the id space from answering
 * questions about what exists.
 */
export async function readMedia(ctx: RequestContext, id: string): Promise<Result<MediaRecord>> {
  const media = await ctx.ports.media.findById(id);
  if (media === null) return fail(ErrorType.NotFound, "No such media record");
  if (media.status === "ready") return ok(media);
  if (ctx.actor !== null && ctx.actor.principalId === media.ownerPrincipalId) return ok(media);
  return fail(ErrorType.NotFound, "No such media record");
}

/**
 * The bytes, for `media.orator.space` (SPEC §57.4).
 *
 * Takes `Ports` rather than a `RequestContext` because the media host is not an
 * authenticated surface: it resolves no token, and giving it a context would imply it
 * could. Only `ready` media has bytes to serve, and only `ready` media is served — the
 * check is here, not in the route, so the API and the media host cannot disagree about
 * what is public.
 */
export async function loadReadyMedia(
  ports: Ports,
  id: string,
): Promise<{ media: MediaRecord; body: MediaBody } | null> {
  const media = await ports.media.findById(id);
  if (media === null || media.status !== "ready" || media.storageKey === null) return null;
  const body = await ports.mediaStore.get(media.storageKey);
  return body === null ? null : { media, body };
}

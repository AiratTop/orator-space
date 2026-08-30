import { ErrorType, SCHEMA_VERSION, versioned, type OratorId } from "@orator/protocol";
import { canCreate, canModify, type DenialReason } from "../identity/authz.js";
import { looksLikeXml, sniff, type MediaKind } from "../media/sniff.js";
import type { MediaBody, MediaRecord, MediaSource, Variant } from "../ports/index.js";
import {
  fail,
  ok,
  withinQuota,
  type AvatarContext,
  type Ports,
  type RequestContext,
  type Result,
} from "./context.js";

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

  // Charged on the record, not on the bytes. §21.1 makes the upload a second call, and a
  // caller that created a thousand records and uploaded none would still have cost a
  // thousand rows for the retention cron to clean up (§23.4).
  const allowance = await withinQuota(ctx, "media");
  if (!allowance.ok) return allowance;

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
    // §46.4 names `media.generation_metadata` as one of the three blobs that must carry a
    // version, and it was the one that did not.
    generationMetadata:
      input.generationMetadata === undefined || input.generationMetadata === null
        ? null
        : versioned(input.generationMetadata),
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
    /**
     * Refused on the header, without reading the body.
     *
     * That saves the platform the transfer but not the caller: Cloudflare does not hand
     * this response back until the request body has been consumed, so a client that
     * ignores the published limit still sends the whole file (measured, §21.1). The limit
     * is in the API description precisely so it can be checked where checking is cheap.
     */
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

/**
 * The key a derived variant is stored under (SPEC §21.2).
 *
 * Beside the original, which is what `storageKeyFor`'s prefix was for. A variant is a
 * derived object with a name, not a query on the original, so it has an address.
 */
export const variantKeyFor = (id: string, variant: Exclude<Variant, "original">): string =>
  `${id}/${variant}`;

export interface VariantPorts {
  media: Ports["media"];
  mediaStore: Ports["mediaStore"];
  transform: Ports["transform"];
}

export interface ServedVariant {
  body: MediaBody;
  contentType: string;
  /** True when the transformation was unavailable and the original is being served (§21.2). */
  fellBack: boolean;
}

/**
 * Serves a named variant, producing it once and storing it (SPEC §21.2, §33.2).
 *
 * **Stored rather than transformed per request, and the reason is the bill.** §21.2 says
 * transformations are billed per unique transformation; it does not say per *request*, and a
 * variant regenerated on every cache miss would turn a bounded set — five names times the
 * number of images — into a number that grows with traffic. Generated once and written to R2,
 * the cost is a property of the library rather than of the audience.
 *
 * The fallback is §21.2's `MUST`: a variant that cannot be produced serves the original. An
 * image is decoration on a page whose subject is text (§2), and a resize service having a bad
 * minute is not a reason for an article not to render.
 */
export async function serveVariant(
  ports: VariantPorts,
  media: { id: string; storageKey: string | null; contentType: string | null },
  variant: Variant,
): Promise<ServedVariant | null> {
  const originalKey = media.storageKey ?? storageKeyFor(media.id);
  const contentType = media.contentType ?? "application/octet-stream";

  if (variant === "original") {
    const body = await ports.mediaStore.get(originalKey);
    return body === null ? null : { body, contentType, fellBack: false };
  }

  // Already produced. The common path by a wide margin: a variant is generated once per
  // image and read for as long as the image exists.
  const stored = await ports.mediaStore.get(variantKeyFor(media.id, variant));
  if (stored !== null) return { body: stored, contentType: VARIANT_CONTENT_TYPE, fellBack: false };

  const source = await ports.mediaStore.get(originalKey);
  if (source === null) return null;

  const produced = await ports.transform.produce(source.body, variant, contentType);
  if (produced === null) {
    /*
     * §21.2 — fall back to the original rather than failing, and do not remember the failure.
     *
     * Nothing is written, so the next request tries again. A negative cache here would turn
     * one bad minute at the platform into a permanently unresized image, and the symptom —
     * a correct picture at the wrong size — is one nobody reports.
     */
    const again = await ports.mediaStore.get(originalKey);
    return again === null ? null : { body: again, contentType, fellBack: true };
  }

  /*
   * Written before it is served, and read back rather than tee'd.
   *
   * A stream can be consumed once. Teeing it would let the response start sooner and would
   * make the stored copy depend on the client finishing the download — a reader who cancels
   * would leave a truncated variant in the bucket, and the next reader would get it.
   */
  const key = variantKeyFor(media.id, variant);
  await ports.mediaStore.putDerived(key, produced.body);
  const written = await ports.mediaStore.get(key);
  if (written === null) {
    const again = await ports.mediaStore.get(originalKey);
    return again === null ? null : { body: again, contentType, fellBack: true };
  }
  return { body: written, contentType: produced.contentType, fellBack: false };
}

/** Every variant but `original` is produced in one format; see the adapter for why. */
const VARIANT_CONTENT_TYPE = "image/webp";

/**
 * Sets a person's picture, in one step (SPEC §49.4, §21.1, §21.2).
 *
 * The API's two-phase path — reserve a record, then stream the bytes — exists because an agent
 * uploading a video needs to know the address before it starts, and because §21.1 counts the
 * bytes as they arrive against what was declared. A browser form has neither problem: it sends
 * one request, and the browser has already told us the length.
 *
 * So this is one call that does both, and the ordering is the interesting part. The bytes land
 * first and the principal is updated only if they did — the reverse would point somebody's
 * profile at a record whose upload then failed, and the symptom is a broken image on the one
 * page they will look at.
 */
export async function setAvatar(
  ctx: AvatarContext,
  input: { body: ReadableStream<Uint8Array>; declaredLength: number; contentType: string },
): Promise<Result<{ mediaId: OratorId }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  if (!input.contentType.startsWith("image/")) {
    return fail(ErrorType.ValidationFailed, "An avatar has to be an image", input.contentType);
  }
  if (input.declaredLength > MAX_AVATAR_BYTES) {
    return fail(
      ErrorType.ValidationFailed,
      "That image is too large",
      `The limit is ${MAX_AVATAR_BYTES / 1024} KB. It is smaller than §59.2's media allowance on purpose: an avatar renders at 128 pixels.`,
    );
  }

  // §59.2 — the same allowance every upload is charged against. An avatar is a small file and
  // a person changes one rarely, so this is not a limit anybody honest meets; it is here
  // because an unmetered path is an unmetered path.
  const allowance = await withinQuota(ctx, "media");
  if (!allowance.ok) return allowance;

  const id = ctx.ports.ids.next();
  const now = ctx.ports.clock.now().toISOString();

  /* The one it replaces, read before anything is written: after the update it is unfindable. */
  const existing = await ctx.ports.principals.findById(actor.principalId);
  const previous = existing?.avatarMediaId ?? null;

  await ctx.ports.db.commit([
    ctx.ports.media.insert({
      id,
      ownerPrincipalId: actor.principalId as OratorId,
      kind: "image",
      altText: null,
      source: "upload",
      generationMetadata: null,
      createdAt: now,
    }),
  ]);

  /*
   * §21.1 — the adapter writes through a fixed-length stream, so a body that disagrees with
   * what the browser declared fails here rather than being stored. A throw is the honest
   * outcome: the record exists and has no bytes, which is the `pending` state retention
   * already sweeps (§23.4).
   */
  let stored;
  try {
    stored = await ctx.ports.mediaStore.put(storageKeyFor(id), input.body, input.declaredLength);
  } catch (error) {
    return fail(ErrorType.ValidationFailed, "That upload could not be stored", String(error));
  }

  await ctx.ports.db.commit([
    ctx.ports.media.markReady(id, {
      storageKey: storageKeyFor(id),
      contentType: input.contentType,
      byteSize: stored.byteSize,
      checksumSha256: stored.sha256,
      finalizedAt: now,
    }),
    /*
     * The old picture is detached here and deleted later (§23.4).
     *
     * Not deleted on the spot: a picture that stopped being somebody's a moment ago is still
     * named by pages held in browsers and at the edge (§33.2), and by any link preview built
     * while it was current. Marking it is what makes it collectable at all — the collector
     * acts on records the platform detached rather than on records it cannot see a reference
     * to, because an article body can name a picture in Markdown where no column does.
     */
    ...(previous === null ? [] : [ctx.ports.media.markDetached(previous, now)]),
    ctx.ports.principals.updateProfile(actor.principalId, { avatarMediaId: id }, now),
  ]);

  return ok({ mediaId: id });
}

/**
 * Takes the picture down, and puts the generated mark back (SPEC §49.4, §23.4).
 *
 * Two writes in one transaction: the profile stops naming the record, and the record is
 * marked detached so the collector can have it a day later. Splitting them is how a bucket
 * ends up holding bytes nobody can reach, or — worse in the other order — a profile pointing
 * at a record that has been marked for collection.
 */
export async function removeAvatar(ctx: AvatarContext): Promise<Result<true>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const principal = await ctx.ports.principals.findById(actor.principalId);
  if (principal === null) return fail(ErrorType.NotFound, "Principal not found");

  const current = principal.avatarMediaId ?? null;
  if (current === null) return ok(true);

  const now = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([
    ctx.ports.principals.updateProfile(actor.principalId, { avatarMediaId: null }, now),
    ctx.ports.media.markDetached(current, now),
  ]);
  return ok(true);
}

/** Small on purpose: it renders at 128 pixels (§21.2), and anything larger is waste in transit. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

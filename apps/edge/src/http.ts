import type { Context, Next } from "hono";
import type { z } from "zod";
import { ErrorType, problem, RETRYABLE, STATUS, type ErrorTypeName } from "@orator/protocol";
import { MAX_CONTENT_BYTES, type Result, type ServiceError } from "@orator/core";

const RETRY_AFTER: Partial<Record<ErrorTypeName, number>> = {
  "rate-limited": 60,
  "quota-exceeded": 3600,
  unavailable: 30,
  "idempotency-in-progress": 2,
};

/**
 * Renders a service failure as RFC 9457 (SPEC §45).
 *
 * Retry-After is attached from the error type rather than from the call site, so the
 * contract §45.1 documents to agents is produced in one place and cannot drift per route.
 */
export function problemResponse(c: Context, error: ServiceError, instance?: string) {
  const status = STATUS[error.type];
  const body = problem(error.type, error.title, {
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(instance === undefined ? {} : { instance }),
    request_id: c.get("requestId") as string,
    ...(error.extra ?? {}),
  });

  // The service's own figure when it has one — a quota knows exactly when its window
  // rolls over — and the per-type default only when it does not.
  const retryAfter = error.retryAfter ?? RETRY_AFTER[error.type];
  if (retryAfter !== undefined) {
    body.retry_after_seconds = retryAfter;
    c.header("retry-after", String(retryAfter));
  }
  if (RETRYABLE.has(error.type)) c.header("x-retryable", "true");

  c.header("content-type", "application/problem+json");
  c.header("cache-control", "private, no-store");
  return c.body(JSON.stringify(body), status as 400);
}

/** Unwraps a service result, rendering the failure branch as a problem document. */
export function respond<T>(c: Context, result: Result<T>, successStatus = 200) {
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);
  // SPEC §33.2 — anything reached with credentials is never publicly cacheable.
  c.header("cache-control", "private, no-store");
  return c.json(result.value as object, successStatus as 200);
}

/**
 * Validates a request body against a protocol schema (SPEC §45.1).
 *
 * Field-level detail is not a nicety here. §45.1 requires that a validation error name the
 * offending field and the reason, because the caller is usually a model: an error it cannot
 * act on programmatically is a defect in the API rather than a message to a person.
 */
export function parse<T>(c: Context, schema: z.ZodType<T>, body: unknown) {
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
 * Validates the whole query string against a protocol schema (SPEC §44.2).
 *
 * The whole of it, and that is the point. §44.2's "unknown fields in a request → 422" is
 * about the request, not about its body, and a route that reads the parameters it knows by
 * name can only ever ignore the rest — so `?cursor=` on an endpoint that pages with
 * something else was answered with the first page, repeatedly, and nothing on either side
 * could tell. Handing the schema `c.req.query()` is what turns that into an error.
 *
 * Only the endpoints whose parameters are declared in the catalogue go through here. The
 * ones still reading `c.req.query("limit")` by hand are a contract gap rather than a
 * behaviour worth preserving, and `conformance.test.ts` now names them.
 */
export function parseQuery<T>(c: Context, schema: z.ZodType<T>) {
  return parse(c, schema, c.req.query());
}

/**
 * SPEC §34.1 — required on every endpoint that creates something.
 *
 * Enforced rather than optional: an autonomous agent that retries without a key produces
 * duplicates, and the platform cannot tell them apart afterwards. Refusing the request is
 * the only point at which that is still fixable.
 */
export function requireIdempotencyKey(c: Context) {
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
 * The size of a JSON request body, decided before it is parsed (SPEC §44.2).
 *
 * Twice the article cap plus room for the rest of the envelope. The body is markdown at
 * most 1 MB (§44.2), and JSON escaping cannot do worse than double it — control characters
 * are refused outright (`validateContent`) and UTF-8 passes through `JSON.stringify`
 * unchanged, so `"` and `\` are the whole of the expansion. The remainder covers a title, a
 * canonical URL and the bounded `metadata`.
 */
export const MAX_JSON_BODY_BYTES = 2 * MAX_CONTENT_BYTES + 64 * 1024;

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

/**
 * Reads a body up to a limit, or gives up on it.
 *
 * Not `Content-Length` alone. The header is a claim, it is absent from a chunked request,
 * and a caller that means to exhaust a Worker's memory is exactly the caller who will lie in
 * it — so the declared length is a cheap early refusal and this is the one that holds. The
 * bytes are buffered rather than passed through, which is what `c.req.json()` did anyway;
 * the difference is that the amount is now bounded and the refusal is a 413 rather than
 * whatever the runtime does when it runs out of room.
 */
async function readAtMost(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concat(chunks, total);
}

/**
 * Refuses an oversized request body before anything parses it (SPEC §44.2, §45.1).
 *
 * `await c.req.json()` reads and parses the whole body first and the 1 MB limit was checked
 * afterwards, in the domain — so a caller could hand the Worker an arbitrarily large
 * document and have it materialised twice, as bytes and as objects, before anything said no.
 * The published limit is only a limit at the point where exceeding it stops costing
 * something, which is here.
 *
 * The uploaded-bytes route is exempt: it streams to R2 without buffering and carries its own
 * much larger limit (§21.1), checked on the declared length for the same reason.
 */
export const bodyLimit =
  (limit = MAX_JSON_BODY_BYTES) =>
  async (c: Context, next: Next): Promise<Response | void> => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();

    const tooLarge = () =>
      problemResponse(
        c,
        {
          type: ErrorType.PayloadTooLarge,
          title: "Request body is larger than the limit",
          detail: `The limit is ${limit} bytes. An article body is capped at 1 MB of markdown (§44.2).`,
          extra: { limit_bytes: limit },
        },
        new URL(c.req.url).pathname,
      );

    const declared = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > limit) return tooLarge();

    const body = c.req.raw.body;
    if (body === null) return next();

    const bytes = await readAtMost(body, limit);
    if (bytes === null) return tooLarge();

    // Handed back as bytes, so every route downstream still reads it with `c.req.json()`.
    c.req.raw = new Request(c.req.raw, { body: bytes });
    return next();
  };

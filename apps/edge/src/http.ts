import type { Context } from "hono";
import type { z } from "zod";
import { ErrorType, problem, RETRYABLE, STATUS, type ErrorTypeName } from "@orator/protocol";
import type { Result, ServiceError } from "@orator/core";

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

  const retryAfter = RETRY_AFTER[error.type];
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

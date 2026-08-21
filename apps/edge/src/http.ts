import type { Context } from "hono";
import { problem, RETRYABLE, STATUS, type ErrorTypeName } from "@orator/protocol";
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

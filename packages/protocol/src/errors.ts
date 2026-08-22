/**
 * SPEC §45 — RFC 9457 Problem Details. `type` URIs are part of the public contract
 * and do not change without a version bump (§46).
 */
export const ERROR_BASE = "https://orator.space/errors/" as const;

export const ErrorType = {
  InvalidRequest: "invalid-request",
  Unauthenticated: "unauthenticated",
  Forbidden: "forbidden",
  InsufficientScope: "insufficient-scope",
  NotFound: "not-found",
  Conflict: "conflict",
  IdempotencyInProgress: "idempotency-in-progress",
  IdempotencyKeyReuse: "idempotency-key-reuse",
  Gone: "gone",
  PreconditionFailed: "precondition-failed",
  PreconditionRequired: "precondition-required",
  PayloadTooLarge: "payload-too-large",
  ValidationFailed: "validation-failed",
  RateLimited: "rate-limited",
  QuotaExceeded: "quota-exceeded",
  UnavailableForLegalReasons: "unavailable-for-legal-reasons",
  InternalError: "internal-error",
  Unavailable: "unavailable",
} as const;

export type ErrorTypeName = (typeof ErrorType)[keyof typeof ErrorType];

/** SPEC §45.1 — whether an autonomous agent should retry. Part of the contract. */
export const RETRYABLE: ReadonlySet<ErrorTypeName> = new Set([
  ErrorType.Conflict,
  ErrorType.IdempotencyInProgress,
  ErrorType.RateLimited,
  ErrorType.QuotaExceeded,
  ErrorType.InternalError,
  ErrorType.Unavailable,
]);

export const STATUS: Readonly<Record<ErrorTypeName, number>> = {
  [ErrorType.InvalidRequest]: 400,
  [ErrorType.Unauthenticated]: 401,
  [ErrorType.Forbidden]: 403,
  [ErrorType.InsufficientScope]: 403,
  [ErrorType.NotFound]: 404,
  [ErrorType.Conflict]: 409,
  [ErrorType.IdempotencyInProgress]: 409,
  [ErrorType.IdempotencyKeyReuse]: 422,
  [ErrorType.Gone]: 410,
  [ErrorType.PreconditionFailed]: 412,
  [ErrorType.PreconditionRequired]: 428,
  [ErrorType.PayloadTooLarge]: 413,
  [ErrorType.ValidationFailed]: 422,
  [ErrorType.RateLimited]: 429,
  [ErrorType.QuotaExceeded]: 429,
  [ErrorType.UnavailableForLegalReasons]: 451,
  [ErrorType.InternalError]: 500,
  [ErrorType.Unavailable]: 503,
};

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  request_id?: string;
  retry_after_seconds?: number;
  [key: string]: unknown;
}

export function problem(
  name: ErrorTypeName,
  title: string,
  extra: Omit<Partial<ProblemDetails>, "type" | "status"> = {},
): ProblemDetails {
  return { type: `${ERROR_BASE}${name}`, title, status: STATUS[name], ...extra };
}

export const isRetryable = (name: ErrorTypeName): boolean => RETRYABLE.has(name);

import { describe, expect, it } from "vitest";
import { ERROR_BASE, ErrorType, isRetryable, problem, STATUS } from "./errors.js";

describe("problem details (SPEC §45)", () => {
  it("emits a stable type URI and the documented status", () => {
    const p = problem(ErrorType.QuotaExceeded, "Publishing quota exceeded", { retry_after_seconds: 3600 });
    expect(p.type).toBe(`${ERROR_BASE}quota-exceeded`);
    expect(p.status).toBe(429);
    expect(p.retry_after_seconds).toBe(3600);
  });

  it("assigns a status to every error type", () => {
    for (const name of Object.values(ErrorType)) expect(STATUS[name]).toBeGreaterThanOrEqual(400);
  });

  it("marks exactly the errors an agent may retry (SPEC §45.1)", () => {
    expect(isRetryable(ErrorType.RateLimited)).toBe(true);
    expect(isRetryable(ErrorType.Unavailable)).toBe(true);
    // Retrying these unchanged would loop forever.
    expect(isRetryable(ErrorType.ValidationFailed)).toBe(false);
    expect(isRetryable(ErrorType.PreconditionFailed)).toBe(false);
    expect(isRetryable(ErrorType.Gone)).toBe(false);
  });
});

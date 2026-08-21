import { ErrorType } from "@orator/protocol";
import { sha256Hex } from "../identity/tokens.js";
import { fail, ok, type RequestContext, type Result, type ServiceError } from "./context.js";

/**
 * Idempotent execution (SPEC §34.1).
 *
 * Autonomous agents retry. Without this the first network timeout produces a duplicate
 * article, and at the publishing rate this system is designed for, a steady stream of
 * them that cannot be cleaned up automatically.
 *
 * The claim is a conditional insert rather than a read-then-write, because two concurrent
 * retries of the same request arrive together and a check-then-act would let both through.
 */
export async function withIdempotency<T>(
  ctx: RequestContext,
  key: string,
  endpoint: string,
  request: unknown,
  operation: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const principalId = ctx.actor?.principalId;
  if (principalId === undefined) return fail(ErrorType.Unauthenticated, "Authentication required");

  const requestHash = await sha256Hex(JSON.stringify(request ?? null));
  const existing = await ctx.ports.idempotency.find(principalId, key);

  if (existing !== null) {
    if (existing.requestHash !== requestHash) {
      // The same key with a different body is a client bug, and replaying the stored
      // response would answer a question that was not asked.
      return fail(
        ErrorType.IdempotencyKeyReuse,
        "Idempotency key reused with a different request body",
        "Use a fresh key for a different request.",
      );
    }
    if (existing.status === "in_progress") {
      return fail(
        ErrorType.IdempotencyInProgress,
        "An identical request is still being processed",
        "Retry shortly; the original request has not finished.",
      );
    }
    const stored = JSON.parse(existing.responseJson ?? "null") as StoredOutcome<T>;
    // A recorded failure replays as that failure. Returning success with a null body
    // would tell the caller the request had worked, which is the opposite of what
    // happened, and is a worse answer than doing the work twice.
    return stored?.ok === false ? { ok: false, error: stored.error } : ok(stored?.value as T);
  }

  const createdAt = ctx.ports.clock.now().toISOString();
  const [claim] = await ctx.ports.db.commit([
    ctx.ports.idempotency.claim({ principalId, key, endpoint, requestHash, createdAt }),
  ]);
  if ((claim?.changes ?? 0) === 0) {
    // Lost the race to a concurrent retry of the same request.
    return fail(ErrorType.IdempotencyInProgress, "An identical request is still being processed");
  }

  let result: Result<T>;
  try {
    result = await operation();
  } catch (error) {
    // Release, so a retry is not permanently blocked by a transient failure.
    await ctx.ports.db.commit([ctx.ports.idempotency.release(principalId, key)]);
    throw error;
  }

  if (!result.ok && isTransient(result.error.type)) {
    await ctx.ports.db.commit([ctx.ports.idempotency.release(principalId, key)]);
    return result;
  }

  // Successes and permanent failures are both recorded: replaying a request that was
  // rejected for being invalid should get the same rejection, not a second attempt.
  const stored: StoredOutcome<T> = result.ok
    ? { ok: true, value: result.value }
    : { ok: false, error: result.error };
  await ctx.ports.db.commit([
    ctx.ports.idempotency.complete(principalId, key, result.ok ? 200 : 400, JSON.stringify(stored)),
  ]);
  return result;
}

/** What is persisted for a completed key — enough to reproduce the original answer. */
type StoredOutcome<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

const isTransient = (type: string): boolean =>
  type === "internal-error" || type === "unavailable" || type === "rate-limited" || type === "quota-exceeded";

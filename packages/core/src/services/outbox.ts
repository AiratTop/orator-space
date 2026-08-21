import type { Ports } from "./context.js";

/**
 * Drains the outbox into the event bus (SPEC §35.2).
 *
 * Two callers, deliberately:
 *
 *   - after a successful mutation, in the background, so delivery latency is milliseconds;
 *   - a cron trigger, as the safety net, because the first path can fail silently.
 *
 * Cron alone is not enough. Its finest granularity is one minute (ADR 0001), so relying
 * on it would make every dropped send cost a minute of pipeline delay. Direct delivery
 * alone is not enough either: it is exactly the step that is not transactional with the
 * write, which is why the row exists in the first place.
 */
export interface DrainResult {
  delivered: number;
  failed: number;
  remaining: number;
}

const BACKOFF_BASE_MS = 2_000;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

export async function drainOutbox(ports: Ports, limit = 50): Promise<DrainResult> {
  const now = ports.clock.now();
  const pending = await ports.outbox.listPending(now.toISOString(), limit);
  if (pending.length === 0) {
    return { delivered: 0, failed: 0, remaining: 0 };
  }

  let delivered = 0;
  let failed = 0;

  try {
    await ports.eventBus.publish(pending);
    await ports.db.commit([ports.outbox.markSent(pending.map((entry) => entry.id), now.toISOString())]);
    delivered = pending.length;
  } catch (error) {
    // The batch is atomic from the bus's point of view, so on failure every row in it is
    // retried. Consumers are idempotent (§34.2), so a duplicate delivery is harmless
    // while a lost one is not — when in doubt, deliver again.
    const message = String((error as Error)?.message ?? error).slice(0, 500);
    await ports.db.commit(
      pending.map((entry) =>
        ports.outbox.markFailed(entry.id, message, backoffFrom(now, entry.attempts).toISOString()),
      ),
    );
    failed = pending.length;
  }

  const stats = await ports.outbox.pendingStats();
  return { delivered, failed, remaining: stats.count };
}

/** Exponential, capped. A permanently broken message must not monopolise the drain. */
function backoffFrom(now: Date, attempts: number): Date {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS);
  return new Date(now.getTime() + delay);
}

import { DurableObject } from "cloudflare:workers";
import {
  LIMITS,
  QUOTA_ACTIONS,
  unmetered,
  verdict,
  windowEnd,
  windowStart,
  type QuotaAction,
  type QuotaGate,
  type QuotaVerdict,
} from "@orator/core";

/**
 * The exact quota counter, one Durable Object per principal (SPEC §59.1).
 *
 * §59.1 separates two problems that look alike. Flood protection is short-window and
 * per-IP, the Rate Limiting binding counts per colo, and approximate is fine there. A quota
 * that decides the right to publish is neither: an agent operating from several regions
 * bypasses a per-colo counter trivially, and "20 articles a day" would mean twenty per
 * colo. Serialisation on one key is the only shape that gives an exact answer, and a
 * Durable Object is that shape.
 *
 * What is *not* here is the rule. `verdict` lives in the domain and is shared with the
 * in-memory double, so both evaluate the same limits; this object holds integers.
 */
interface Counter {
  /** The window's start, epoch ms. A stored counter from an older window reads as zero. */
  window: number;
  count: number;
}

export class QuotaCounter extends DurableObject {
  /**
   * Counts one use and returns the verdict (SPEC §59.2).
   *
   * The count rises even when the answer is no. A counter that stopped at the limit would
   * let a caller hammer an endpoint at no cost and leave no trace that anything had tried,
   * and the count is exactly the signal §60.1 wants.
   *
   * `storage.transaction` rather than a bare get/put pair: a Durable Object serialises
   * requests but not the `await` points inside one, and read-modify-write across an await
   * is a race even here. This is the interactive transaction D1 does not have (§31.1).
   */
  async consume(action: QuotaAction, trustLevel: number, now: number): Promise<QuotaVerdict> {
    const start = windowStart(LIMITS[action].window, new Date(now));

    const count = await this.ctx.storage.transaction(async (txn) => {
      const held = await txn.get<Counter>(action);
      const next = held !== undefined && held.window === start ? held.count + 1 : 1;
      await txn.put(action, { window: start, count: next } satisfies Counter);
      return next;
    });

    await this.scheduleCleanup(now);
    return verdict(action, count, trustLevel, new Date(now));
  }

  /** SPEC §59.2 — what is left, without spending any of it. */
  async peek(trustLevel: number, now: number): Promise<QuotaVerdict[]> {
    const held = await this.ctx.storage.get<Counter>([...QUOTA_ACTIONS]);
    return QUOTA_ACTIONS.map((action) => {
      const start = windowStart(LIMITS[action].window, new Date(now));
      const counter = held.get(action);
      const used = counter !== undefined && counter.window === start ? counter.count : 0;
      return verdict(action, used, trustLevel, new Date(now));
    });
  }

  /**
   * Empties the object once every window it holds has rolled over.
   *
   * Not for correctness — a stale counter already reads as zero, because the stored window
   * no longer matches. This is about what an idle principal costs: a Durable Object that
   * holds nothing is far cheaper than one holding a row per action for every account that
   * ever published once, and §67.2 names exactly that kind of accumulation as what ruins a
   * bill. Set only when there is no alarm pending, so an active principal is not
   * rescheduling on every write.
   */
  private async scheduleCleanup(now: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(windowEnd("day", new Date(now)) + 60_000);
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/**
 * The gate the application services see.
 *
 * `idFromName(principalId)` is what makes the count exact: one object per principal,
 * globally, whichever colo the request arrives at. The id is derived rather than stored, so
 * nothing has to be looked up before the counter can be reached.
 */
export function createQuotaGate(namespace: DurableObjectNamespace<QuotaCounter>): QuotaGate {
  const stubFor = (principalId: string) => namespace.get(namespace.idFromName(principalId));

  /**
   * One immediate retry, then the write is allowed unmetered (SPEC §59.1, §61).
   *
   * A Durable Object is a network hop, and putting one on the write path of every publish
   * put a new single point of failure there. §61 already settles what this platform does
   * with an unavailable dependency: content whose moderation provider is unreachable is
   * published and marked unchecked rather than blocked. A quota is the same shape of
   * decision — one hiccup must not mean the platform accepts no writes, and the flood
   * limiter still bounds throughput while the counter is away.
   *
   * The retry is immediate and single. A backoff belongs where the caller is a queue
   * consumer, not on a request a person or an agent is waiting on; and a second failure
   * within milliseconds is not a blip.
   */
  async function attempt<T>(operation: () => Promise<T>, fallback: (error: unknown) => T): Promise<T> {
    try {
      return await operation();
    } catch {
      try {
        return await operation();
      } catch (error) {
        return fallback(error);
      }
    }
  }

  const report = (principalId: string, action: string, error: unknown) =>
    console.error(
      JSON.stringify({
        level: "error",
        event: "quota.unavailable",
        // §66.4 alerts on this: an unmetered write is a limit that did not apply, and an
        // attacker who could keep the counter unreachable would publish without one.
        principal_id: principalId,
        action,
        error: String(error),
      }),
    );

  return {
    consume: (principalId, action, trustLevel) =>
      attempt(
        () => stubFor(principalId).consume(action, trustLevel, Date.now()),
        (error) => {
          report(principalId, action, error);
          return unmetered(action, trustLevel, new Date());
        },
      ),

    peek: (principalId, trustLevel) =>
      attempt(
        () => stubFor(principalId).peek(trustLevel, Date.now()),
        (error) => {
          report(principalId, "peek", error);
          // Reporting a full allowance would be a lie an agent plans against. Every entry
          // says `metered: false`, which is the honest answer: nothing is known.
          return QUOTA_ACTIONS.map((action) => unmetered(action, trustLevel, new Date()));
        },
      ),
  };
}

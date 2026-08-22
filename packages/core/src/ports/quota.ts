import type { QuotaAction, QuotaVerdict } from "../identity/quota.js";

/**
 * The exact, global counter behind a quota (SPEC §59.1).
 *
 * A port rather than a call to storage, because the two mechanisms §59.1 separates have
 * different homes: flood protection is per-colo and approximate and belongs in the HTTP
 * edge, while a quota that decides the right to publish has to be serialised on one key.
 * The domain states the rule; this is the only thing that knows where the number lives.
 *
 * **MUST be called after authorisation and before the write.** Consuming before the actor
 * is known charges the wrong principal; consuming after the write means a refusal arrives
 * with the row already created.
 */
export interface QuotaGate {
  /**
   * Counts one use and says whether it was within the allowance.
   *
   * Increments even when it refuses. A counter that stopped rising at the limit would let
   * a caller hammer the endpoint at no cost to itself and no visibility to anyone else —
   * the count *is* the signal that something is trying (§60.1).
   *
   * `trustLevel` is passed in rather than looked up: the counter holds counts, not
   * identities, and a store that had to read a principal to decide a limit would be one
   * more read on the write path of every publish.
   */
  consume(principalId: string, action: QuotaAction, trustLevel: number): Promise<QuotaVerdict>;

  /**
   * What is left, without spending any of it (SPEC §59.2).
   *
   * "An agent that does not know its remaining allowance cannot plan its work" — so this
   * exists for `GET /v1/principals/{id}/quota`, and it must not be a `consume` that the
   * caller discards.
   */
  peek(principalId: string, trustLevel: number): Promise<QuotaVerdict[]>;
}

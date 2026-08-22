/**
 * Quotas (SPEC §59.2, §60.2).
 *
 * The numbers and the arithmetic live here, in the domain, and the counter lives behind a
 * port. That split is the point of §59.1: a quota that decides the right to publish has to
 * be exact and global, which is a storage problem, while *what the limit is* — how it
 * varies with trust level, when the window rolls over, what a caller is told when it is
 * refused — is a product decision, and product decisions belong where they can be read and
 * tested without a runtime.
 */

/** SPEC §59.2 — every action with a quota. Flood protection is separate (§59.1). */
export const QUOTA_ACTIONS = [
  "articles.publish",
  "articles.draft",
  "comments",
  "follows",
  "edges",
  "media",
  "agents",
] as const;

export type QuotaAction = (typeof QUOTA_ACTIONS)[number];

export type QuotaWindow = "hour" | "day";

export interface QuotaLimit {
  action: QuotaAction;
  window: QuotaWindow;
  /** The level-1 allowance. Every other level is a multiple of it, see MULTIPLIER. */
  baseline: number;
}

/**
 * SPEC §59.2, transcribed. The values are starting points and are meant to move.
 *
 * `agents` is counted against the *owner*, not the agent: §60.3's sybil argument is about
 * one person creating many agents, and charging the new agent for its own creation would
 * count nothing at all.
 */
export const LIMITS: Readonly<Record<QuotaAction, QuotaLimit>> = {
  "articles.publish": { action: "articles.publish", window: "day", baseline: 20 },
  "articles.draft": { action: "articles.draft", window: "day", baseline: 100 },
  comments: { action: "comments", window: "hour", baseline: 60 },
  follows: { action: "follows", window: "day", baseline: 200 },
  edges: { action: "edges", window: "day", baseline: 100 },
  media: { action: "media", window: "day", baseline: 200 },
  agents: { action: "agents", window: "day", baseline: 10 },
};

/**
 * SPEC §60.2 — the trust level decides the multiplier.
 *
 * Level 0 is deliberately below baseline rather than equal to it. A new principal is the
 * one shape a sybil attack takes (§60.3), and "minimum limits" in §60.2 has to mean
 * something a spammer notices; a level that costs nothing to reach and grants the full
 * allowance would make the ladder decorative.
 *
 * Level 1 — a verified owner, seven days of age, no violations — is the ordinary state of
 * an honest account, so it is where the published numbers apply.
 */
export const MULTIPLIER: Readonly<Record<number, number>> = { 0: 0.25, 1: 1, 2: 3, 3: 10 };

export const limitFor = (action: QuotaAction, trustLevel: number): number => {
  const multiplier = MULTIPLIER[Math.max(0, Math.min(3, Math.trunc(trustLevel)))] ?? 1;
  // At least one, always. A multiplier that rounded a small limit to zero would ban the
  // action outright, which is a different decision from limiting it and not this one to make.
  return Math.max(1, Math.round(LIMITS[action].baseline * multiplier));
};

/**
 * Fixed windows, aligned to the clock, not sliding.
 *
 * A sliding window is fairer and costs a stored timestamp per request; a fixed one costs a
 * counter and an integer. At these limits the difference a caller can exploit is one extra
 * allowance across a boundary, which is not the abuse §59 is defending against — and the
 * counter has to be cheap, because it sits on the write path of every publish.
 *
 * Returned as an epoch millisecond so that a stored window is comparable with `<`, and the
 * caller never has to parse anything to know whether its counter is stale.
 */
export const windowStart = (window: QuotaWindow, at: Date): number => {
  const ms = at.getTime();
  const size = window === "hour" ? 3_600_000 : 86_400_000;
  return Math.floor(ms / size) * size;
};

export const windowEnd = (window: QuotaWindow, at: Date): number =>
  windowStart(window, at) + (window === "hour" ? 3_600_000 : 86_400_000);

/** What a caller is told, whether it was allowed or refused (SPEC §59.2, §45). */
export interface QuotaVerdict {
  action: QuotaAction;
  allowed: boolean;
  limit: number;
  /** After this call, if it was allowed; as it stands, if it was not. Never negative. */
  remaining: number;
  window: QuotaWindow;
  /** RFC 3339 — when the allowance returns. */
  resetAt: string;
  /** Seconds until `resetAt`, for `Retry-After`. At least one: zero means "immediately". */
  retryAfterSeconds: number;
  /**
   * False when the counter could not be reached and the call was allowed unmetered.
   *
   * §61 already settles what an unavailable dependency does here: content whose moderation
   * provider is unreachable is published and marked unchecked, rather than blocked. The
   * same reasoning applies to a counter — degrade the consequence, not the user's ability
   * to act. A quota that fails closed turns one Durable Object hiccup into a platform that
   * accepts no writes, and the flood limiter (§59.1) still bounds the damage meanwhile.
   *
   * It is never silently false: an unmetered call is logged and alerted on (§66.4). An
   * attacker who can make the counter unreachable would otherwise have found a way to
   * publish without limit and leave no trace of it.
   */
  metered: boolean;
}

/**
 * The whole decision, as a function of a count and a clock.
 *
 * Separate from the counter so that both the Durable Object and the in-memory double
 * evaluate the same rule. A limit enforced by two implementations is a limit with two
 * behaviours, and the one nobody tests is the one that runs in production.
 */
export function verdict(
  action: QuotaAction,
  used: number,
  trustLevel: number,
  at: Date,
): QuotaVerdict {
  const { window } = LIMITS[action];
  const limit = limitFor(action, trustLevel);
  const ends = windowEnd(window, at);

  return {
    action,
    allowed: used <= limit,
    limit,
    remaining: Math.max(0, limit - used),
    window,
    resetAt: new Date(ends).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((ends - at.getTime()) / 1000)),
    metered: true,
  };
}

/**
 * The verdict when the counter could not be reached (SPEC §59.1, §61).
 *
 * Allowed, and marked. The caller is told the truth about what is known — nothing — rather
 * than a `remaining` figure invented to look like an answer.
 */
export function unmetered(action: QuotaAction, trustLevel: number, at: Date): QuotaVerdict {
  return { ...verdict(action, 0, trustLevel, at), metered: false };
}

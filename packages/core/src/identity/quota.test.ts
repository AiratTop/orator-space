import { describe, expect, it } from "vitest";
import { limitFor, LIMITS, verdict, windowEnd, windowStart } from "./quota.js";

/**
 * SPEC §59.2, §60.2 — the limits and the arithmetic around them.
 *
 * The numbers themselves are transcribed from the specification and checked against it
 * here, because a limit that quietly drifts from the published one is a promise broken to
 * every agent that read the documentation and planned its work against it (§59.2).
 */

const AT = new Date("2026-08-22T14:37:11.500Z");

describe("the published limits (§59.2)", () => {
  it("matches the table, at the level the table is written for", () => {
    // §60.2 puts an ordinary honest account at level 1 — a verified owner, seven days of
    // age, no violations — so that is where the published numbers apply.
    expect(limitFor("articles.publish", 1)).toBe(20);
    expect(limitFor("articles.draft", 1)).toBe(100);
    expect(limitFor("comments", 1)).toBe(60);
    expect(limitFor("follows", 1)).toBe(200);
    expect(limitFor("edges", 1)).toBe(100);
    expect(limitFor("media", 1)).toBe(200);
    expect(limitFor("agents", 1)).toBe(10);
  });

  it("puts comments on an hour and everything else on a day", () => {
    expect(LIMITS.comments.window).toBe("hour");
    for (const action of ["articles.publish", "follows", "edges", "media", "agents"] as const) {
      expect(LIMITS[action].window, action).toBe("day");
    }
  });
});

describe("trust levels (§60.2)", () => {
  it("gives a brand-new principal less than the baseline", () => {
    // "Minimum limits" has to mean something a spammer notices. A level that costs nothing
    // to reach and grants the full allowance would make the ladder decorative (§60.3).
    expect(limitFor("articles.publish", 0)).toBeLessThan(limitFor("articles.publish", 1));
  });

  it("raises the allowance as trust is earned", () => {
    const ladder = [0, 1, 2, 3].map((level) => limitFor("articles.publish", level));
    expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
    expect(new Set(ladder).size).toBe(4);
  });

  it("never rounds a limit down to zero", () => {
    // A multiplier that banned an action outright would be a different decision from
    // limiting it, and not one the trust ladder is entitled to make.
    for (const level of [0, 1, 2, 3]) expect(limitFor("agents", level)).toBeGreaterThanOrEqual(1);
  });

  it("treats a level outside the range as the nearest one inside it", () => {
    expect(limitFor("comments", -5)).toBe(limitFor("comments", 0));
    expect(limitFor("comments", 99)).toBe(limitFor("comments", 3));
  });
});

describe("windows", () => {
  it("aligns to the clock rather than to first use", () => {
    expect(new Date(windowStart("hour", AT)).toISOString()).toBe("2026-08-22T14:00:00.000Z");
    expect(new Date(windowStart("day", AT)).toISOString()).toBe("2026-08-22T00:00:00.000Z");
  });

  it("ends exactly one window after it starts", () => {
    expect(windowEnd("hour", AT) - windowStart("hour", AT)).toBe(3_600_000);
    expect(windowEnd("day", AT) - windowStart("day", AT)).toBe(86_400_000);
  });
});

describe("the verdict (§59.2, §45.1)", () => {
  it("allows the call that reaches the limit and refuses the one after it", () => {
    // `used` counts this call. Twenty published articles is twenty allowed, not nineteen.
    expect(verdict("articles.publish", 20, 1, AT).allowed).toBe(true);
    expect(verdict("articles.publish", 21, 1, AT).allowed).toBe(false);
  });

  it("reports what is left, and never a negative number", () => {
    expect(verdict("articles.publish", 5, 1, AT).remaining).toBe(15);
    expect(verdict("articles.publish", 99, 1, AT).remaining).toBe(0);
  });

  it("says when the allowance returns, as a time and as a wait", () => {
    const refused = verdict("comments", 999, 1, AT);
    expect(refused.resetAt).toBe("2026-08-22T15:00:00.000Z");
    // §45.1 requires Retry-After on every 429, and the real figure beats a default: telling
    // an agent to come back in an hour when the window rolls over in 23 minutes throws away
    // 37 minutes of its work.
    // 14:37:11.500 to 15:00:00 is 1368.5 seconds, rounded up.
    expect(refused.retryAfterSeconds).toBe(1369);
  });

  it("never asks a caller to retry in zero seconds", () => {
    const atTheBoundary = new Date("2026-08-22T14:59:59.999Z");
    expect(verdict("comments", 999, 1, atTheBoundary).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

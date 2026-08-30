import { describe, expect, it } from "vitest";
import * as s from "./schemas.js";

/**
 * The two scalars every other schema is built from (SPEC §12, §44.2).
 *
 * Tested here rather than through a route because both were, until recently, descriptions
 * rather than checks — and the failures they let through surfaced far away: a token that
 * never expired, a publication date compared as a string.
 */

describe("timestamp", () => {
  it("takes the shape §44.2 names", () => {
    expect(s.timestamp.safeParse("2026-08-30T12:00:00.000Z").success).toBe(true);
    expect(s.timestamp.safeParse("2024-02-29T00:00:00.000Z").success).toBe(true);
  });

  it("refuses anything that is not that shape", () => {
    for (const bad of [
      "2026-08-30T12:00:00Z", // no milliseconds
      "2026-08-30T12:00:00.000+02:00", // not UTC
      "2026-08-30 12:00:00.000Z", // no T
      "2026-08-30",
      "soon",
      "",
    ]) {
      expect(s.timestamp.safeParse(bad).success, bad).toBe(false);
    }
  });

  /**
   * The half a regexp cannot do, and the half `Date.parse` does not do either: it rolls an
   * impossible day over into the next month rather than refusing it, so a parse that
   * succeeds proves nothing. The round trip is what refuses these.
   */
  it("refuses a day that does not exist, which JavaScript would silently move", () => {
    for (const bad of [
      "2026-02-30T00:00:00.000Z", // -> 2026-03-02
      "2026-04-31T00:00:00.000Z", // -> 2026-05-01
      "2025-02-29T00:00:00.000Z", // not a leap year -> 2025-03-01
      "2026-01-01T24:00:00.000Z", // -> 2026-01-02
    ]) {
      expect(s.timestamp.safeParse(bad).success, bad).toBe(false);
      // Named explicitly: each one parses, which is why the round trip is the check.
      expect(Number.isNaN(Date.parse(bad)), `${bad} parses`).toBe(false);
    }
  });
});

describe("oratorId", () => {
  const real = "06G551SAR9R0166Q2YM3ADCXJ8";

  it("takes an id this platform issued", () => {
    expect(s.oratorId.safeParse(real).success).toBe(true);
  });

  it("refuses the right length made of the wrong things", () => {
    for (const bad of ["not an id at all, 26 chars", "0".repeat(25), "0".repeat(27), `${real}X`]) {
      expect(s.oratorId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("refuses a second spelling of an id that already exists (§12)", () => {
    // The low two bits of the last character are padding and are always zero. Setting them
    // decodes to the same sixteen bytes, so this would be a different string for one entity.
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const last = alphabet.indexOf(real[25]!);
    const shadow = real.slice(0, 25) + alphabet[last | 0b01]!;

    expect(shadow).not.toBe(real);
    expect(s.oratorId.safeParse(shadow).success).toBe(false);
  });
});

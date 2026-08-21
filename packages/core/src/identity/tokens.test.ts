import { describe, expect, it } from "vitest";
import { bearerFrom, generateToken, isExpired, sha256Hex, TOKEN_PREFIX } from "./tokens.js";

describe("api tokens (SPEC §42.2)", () => {
  it("returns a token, its hash and a displayable prefix", async () => {
    const { token, tokenHash, prefix } = await generateToken();
    expect(token.startsWith(`${TOKEN_PREFIX}_live_`)).toBe(true);
    expect(tokenHash).toHaveLength(64);
    expect(tokenHash).toBe(await sha256Hex(token));
    expect(token.startsWith(prefix)).toBe(true);
    // The prefix identifies without being usable.
    expect(prefix.length).toBeLessThan(token.length);
  });

  it("never repeats", async () => {
    const tokens = await Promise.all(Array.from({ length: 200 }, () => generateToken()));
    expect(new Set(tokens.map((t) => t.token)).size).toBe(200);
  });

  it("carries enough entropy that guessing is not a strategy", async () => {
    const { token } = await generateToken();
    const secret = token.split("_")[3] ?? "";
    expect(secret.length).toBeGreaterThanOrEqual(40); // 32 bytes in base62
  });
});

describe("bearer extraction", () => {
  it("accepts the standard header, case-insensitively", async () => {
    const { token } = await generateToken();
    expect(bearerFrom(`Bearer ${token}`)).toBe(token);
    expect(bearerFrom(`bearer ${token}`)).toBe(token);
  });

  it("rejects anything that is not a bearer token of ours", () => {
    expect(bearerFrom(null)).toBeNull();
    expect(bearerFrom("")).toBeNull();
    expect(bearerFrom("Basic abc")).toBeNull();
    expect(bearerFrom("Bearer")).toBeNull();
    // A session cookie value must never authenticate an API call (SPEC §9.1).
    expect(bearerFrom("Bearer sess_abc123")).toBeNull();
  });
});

describe("expiry", () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  it("treats a null expiry as non-expiring", () => {
    expect(isExpired(null, now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false);
  });
  it("expires on the boundary, not after it", () => {
    expect(isExpired("2026-08-21T12:00:00.000Z", now)).toBe(true);
    expect(isExpired("2026-08-21T12:00:00.001Z", now)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { decodeId, idTimestamp, isOratorId } from "@orator/protocol";
import { createIdGen } from "./id-gen.js";

describe("UUIDv7 id generation (SPEC §12)", () => {
  it("produces well-formed identifiers", () => {
    const id = createIdGen().next();
    expect(isOratorId(id)).toBe(true);
    expect(idTimestamp(id)).toBeCloseTo(Date.now(), -3);
  });

  it("stays strictly ordered within a single millisecond", () => {
    // The clock is frozen, so only the sub-millisecond counter can separate these.
    // Without it the pagination cursor could skip a row (SPEC §12.2, §20.5).
    const idGen = createIdGen(() => 1_800_000_000_000);
    const ids = Array.from({ length: 4096 }, () => idGen.next());
    expect(new Set(ids).size).toBe(4096);
    expect([...ids].sort()).toEqual(ids);
  });

  it("keeps ordering when the counter overflows into the next millisecond", () => {
    const idGen = createIdGen(() => 1_800_000_000_000);
    const ids = Array.from({ length: 5000 }, () => idGen.next());
    expect(new Set(ids).size).toBe(5000);
    expect([...ids].sort()).toEqual(ids);
  });

  it("never goes backwards when the clock does", () => {
    let now = 1_800_000_000_000;
    const idGen = createIdGen(() => now);
    const before = idGen.next();
    now -= 5_000; // NTP correction, or a colo with a skewed clock
    const after = idGen.next();
    expect(after > before).toBe(true);
  });

  it("sets the UUIDv7 version and variant bits", () => {
    const id = createIdGen().next();
    const bytes = decodeId(id);
    expect(bytes[6]! >> 4).toBe(0x7);
    expect(bytes[8]! >> 6).toBe(0b10);
  });
});

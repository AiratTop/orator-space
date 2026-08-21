import { describe, expect, it } from "vitest";
import { decodeId, encodeId, idTimestamp, isOratorId } from "./ids.js";

describe("orator ids (SPEC §12)", () => {
  it("encodes 16 bytes as 26 Crockford base32 characters", () => {
    const id = encodeId(new Uint8Array(16));
    expect(id).toHaveLength(26);
    expect(isOratorId(id)).toBe(true);
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = (i * 37 + 11) & 0xff;
    expect([...decodeId(encodeId(bytes))]).toEqual([...bytes]);
  });

  it("sorts lexicographically in timestamp order — the property the cursor relies on", () => {
    const make = (ms: number) => {
      const bytes = new Uint8Array(16);
      for (let i = 5; i >= 0; i--) {
        bytes[i] = ms & 0xff;
        ms = Math.floor(ms / 256);
      }
      return encodeId(bytes);
    };
    const ids = [make(3), make(1), make(2)];
    expect([...ids].sort()).toEqual([make(1), make(2), make(3)]);
  });

  it("recovers the embedded millisecond timestamp", () => {
    const bytes = new Uint8Array(16);
    let ms = 1_800_000_000_000;
    for (let i = 5; i >= 0; i--) {
      bytes[i] = ms & 0xff;
      ms = Math.floor(ms / 256);
    }
    expect(idTimestamp(encodeId(bytes))).toBe(1_800_000_000_000);
  });

  it("rejects malformed identifiers", () => {
    expect(isOratorId("too-short")).toBe(false);
    expect(isOratorId("01K3EXAMPLE7Q9ZR4T2WY6C8FU")).toBe(false); // U is not in the alphabet
    expect(() => decodeId("0".repeat(25))).toThrow(RangeError);
    expect(() => encodeId(new Uint8Array(8))).toThrow(RangeError);
  });
});

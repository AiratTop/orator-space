import type { IdGen } from "@orator/core/ports";
import { encodeId, type OratorId } from "@orator/protocol";

/**
 * UUIDv7 (RFC 9562): 48-bit big-endian millisecond timestamp, 4-bit version,
 * 12-bit sub-millisecond counter, 2-bit variant, 62 bits of randomness.
 *
 * The counter guarantees ordering within a millisecond, which matters because the id
 * is also the pagination cursor (SPEC §12.2) — two events in the same millisecond must
 * still sort deterministically, or a cursor can skip one.
 */
export function createIdGen(now: () => number = Date.now): IdGen {
  let lastMs = -1;
  let counter = 0;

  return {
    next(): OratorId {
      const ms = now();
      if (ms > lastMs) {
        lastMs = ms;
        counter = 0;
      } else {
        // Same millisecond, or the clock moved backwards. Either way we stay on the
        // last timestamp we emitted and let the counter separate the ids, so the
        // sequence never repeats and never goes backwards.
        counter += 1;
        if (counter > 0xfff) {
          // 4096 ids inside one millisecond is not a real workload, but borrowing from
          // the next millisecond keeps the sequence unique and ordered if it happens.
          lastMs += 1;
          counter = 0;
        }
      }

      const bytes = new Uint8Array(16);
      const timestamp = lastMs;
      bytes[0] = (timestamp / 2 ** 40) & 0xff;
      bytes[1] = (timestamp / 2 ** 32) & 0xff;
      bytes[2] = (timestamp / 2 ** 24) & 0xff;
      bytes[3] = (timestamp / 2 ** 16) & 0xff;
      bytes[4] = (timestamp / 2 ** 8) & 0xff;
      bytes[5] = timestamp & 0xff;

      bytes[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + counter high nibble
      bytes[7] = counter & 0xff;

      const random = new Uint8Array(8);
      crypto.getRandomValues(random);
      bytes[8] = 0x80 | (random[0]! & 0x3f); // variant 10
      for (let i = 1; i < 8; i++) bytes[8 + i] = random[i]!;

      return encodeId(bytes);
    },
  };
}

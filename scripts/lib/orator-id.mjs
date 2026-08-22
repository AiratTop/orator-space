/**
 * An Orator id, for the operator scripts (SPEC §12).
 *
 * A second implementation of `packages/protocol/src/ids.ts`, and it exists because the
 * scripts that bootstrap a moderator (§43.3) and a canary (§66.7) write rows directly and
 * cannot reach the TypeScript workspace without a loader flag on every invocation.
 *
 * Two implementations of one encoding is a rule with two behaviours waiting to happen, so
 * `packages/protocol/src/ids.test.ts` runs both against the same bytes and fails if they
 * disagree. The first hand-rolled version of this produced 22-character ids that
 * `isOratorId` rejects outright — which is exactly the failure that test now prevents.
 */

/** Crockford base32: no I, L, O or U, so a written id cannot be misread (§12.2). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LENGTH = 26;

/** 16 bytes as 26 characters — 130 bits, with the top two always zero. */
export function encodeId(bytes) {
  if (bytes.length !== 16) throw new RangeError(`expected 16 bytes, got ${bytes.length}`);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value <<= 2n;

  const out = new Array(ID_LENGTH);
  for (let i = ID_LENGTH - 1; i >= 0; i -= 1) {
    out[i] = CROCKFORD[Number(value & 31n)];
    value >>= 5n;
  }
  return out.join("");
}

/**
 * A fresh id: 48 bits of time, then 80 of randomness.
 *
 * Sortable by creation, which §12.2 requires — the id is the cursor for every listing in the
 * system, and a random one would make pagination a coin toss under concurrent inserts.
 */
export function newId(at = new Date()) {
  const bytes = new Uint8Array(16);
  let ms = BigInt(at.getTime());
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  crypto.getRandomValues(bytes.subarray(6));
  return encodeId(bytes);
}

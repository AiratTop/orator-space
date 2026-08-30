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

/** The inverse of `encodeId`, for checking that a string a human typed is an id. */
export function decodeId(id) {
  if (id.length !== ID_LENGTH) throw new RangeError(`expected ${ID_LENGTH} characters, got ${id.length}`);
  let value = 0n;
  for (const char of id) {
    const index = CROCKFORD.indexOf(char);
    if (index < 0) throw new RangeError(`invalid Crockford base32 character: ${char}`);
    value = (value << 5n) | BigInt(index);
  }
  value >>= 2n;
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i -= 1) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
}

/**
 * Is this an identifier, in the sense `packages/protocol` means (§12)?
 *
 * The same three questions and deliberately not a fourth: alphabet, length, and canonical
 * encoding. Not the UUIDv7 bits, for the reason ADR 0014 gives — rows written before the
 * generator was fixed would fail, and this is used to check ids that already exist.
 *
 * It is also what makes interpolating one into SQL safe below: the alphabet is 32 characters
 * and none of them is a quote.
 */
export function isOratorId(value) {
  if (typeof value !== "string" || value.length !== ID_LENGTH) return false;
  if (![...value].every((char) => CROCKFORD.includes(char))) return false;
  return encodeId(decodeId(value)) === value;
}

/**
 * A fresh id: 48 bits of time, then a UUIDv7's version and variant, then randomness.
 *
 * Sortable by creation, which §12.2 requires — the id is the cursor for every listing in the
 * system, and a random one would make pagination a coin toss under concurrent inserts.
 *
 * **The version and variant bits are not decoration.** §12 says UUIDv7, and this used to fill
 * bytes 6 to 15 with plain randomness, so what it produced was a sortable 128-bit value that
 * was not a UUID of any version. It went unnoticed because the only check anybody ran was the
 * alphabet and the length — the encoders were compared byte for byte, and both encoded a
 * non-UUID identically. `create-canary.mjs` and `grant-moderator.mjs` write their rows with
 * this, so the canary on staging carries one: `06G2NJ9TMHSJW1VEPDFDJX64J0`, RFC 9562 variant
 * `00`, which is the reserved-for-NCS value and means nothing here.
 *
 * That row cannot be corrected — §11 makes an identifier immutable and forbids reuse, even
 * for a deleted object — so the fix is forward only: ids minted from here on are UUIDv7, and
 * `isOratorId` deliberately does not check these bits. ADR 0014 counts what is affected (it
 * is not only this script: the topic vocabulary migration wrote sixty more) and carries the
 * migration that lets the check be tightened.
 */
export function newId(at = new Date()) {
  const bytes = new Uint8Array(16);
  let ms = BigInt(at.getTime());
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // RFC 9562 variant 10
  return encodeId(bytes);
}

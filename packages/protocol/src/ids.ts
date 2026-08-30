/**
 * SPEC §12 — one identifier per entity: UUIDv7 rendered as 26-character Crockford base32.
 * Monotonic, so it doubles as the pagination cursor (§12.2) with no extra column.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LENGTH = 26;

export type OratorId = string & { readonly __brand: "OratorId" };

/** Encodes 16 bytes as 26 Crockford base32 characters (130 bits, top 2 bits always zero). */
export function encodeId(bytes: Uint8Array): OratorId {
  if (bytes.length !== 16) throw new RangeError(`expected 16 bytes, got ${bytes.length}`);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value <<= 2n; // pad 128 -> 130 bits so the string is exactly 26 chars
  const out = new Array<string>(ID_LENGTH);
  for (let i = ID_LENGTH - 1; i >= 0; i--) {
    out[i] = CROCKFORD[Number(value & 31n)]!;
    value >>= 5n;
  }
  return out.join("") as OratorId;
}

export function decodeId(id: string): Uint8Array {
  if (id.length !== ID_LENGTH) throw new RangeError(`expected ${ID_LENGTH} characters, got ${id.length}`);
  let value = 0n;
  for (const char of id) {
    const index = CROCKFORD.indexOf(char);
    if (index < 0) throw new RangeError(`invalid Crockford base32 character: ${char}`);
    value = (value << 5n) | BigInt(index);
  }
  value >>= 2n;
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return bytes;
}

const ID_PATTERN = new RegExp(`^[${CROCKFORD}]{${ID_LENGTH}}$`);

/**
 * SPEC §12 — is this an identifier this platform could have issued?
 *
 * The alphabet and the length are the cheap half, and were for a while the whole of it. Added
 * to them: the encoding has to be canonical. `encodeId` pads 128 bits out to 130, so the low
 * two bits of the last character are always zero, and a string that sets them decodes to the
 * *same sixteen bytes* as a real id. That is a second spelling of one entity, which is what
 * §12's "one id per entity" exists to prevent, and the round trip is what rejects it.
 *
 * **What is deliberately not checked: the UUIDv7 version and variant bits.** §12 says
 * UUIDv7, `createIdGen` emits one, and checking for it here would be the obvious next step —
 * except that `scripts/lib/orator-id.mjs` did not set those bits until 2026-08-30, and the
 * two scripts that use it write rows directly. The staging canary (§66.7) is one such row:
 * `06G2NJ9TMHSJW1VEPDFDJX64J0`, variant `00`. §11 makes an identifier immutable and forbids
 * reuse, so that row cannot be corrected and the principal cannot be re-minted — a validator
 * that demanded the bits would permanently refuse an account this project created, and
 * refuse it at `POST /v1/tokens`, which is where the canary's credential comes from.
 *
 * The generator is fixed forward. Tightening this is a §65 contract step for after the last
 * such row is gone, not a hardening to slip in now.
 *
 * Cheap enough to run per request: sixteen bytes of shifting, no allocation worth naming.
 */
export const isOratorId = (value: unknown): value is OratorId => {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return false;
  return encodeId(decodeId(value)) === value;
};

/** Milliseconds since epoch encoded in the leading 48 bits of a UUIDv7. */
export function idTimestamp(id: OratorId): number {
  const bytes = decodeId(id);
  let ms = 0;
  for (let i = 0; i < 6; i++) ms = ms * 256 + bytes[i]!;
  return ms;
}

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
 * **What is deliberately not checked: the UUIDv7 version and variant bits (ADR 0014).** Two
 * things wrote identifiers here that were not UUIDv7 — `scripts/lib/orator-id.mjs` until
 * 2026-08-30, and `0011_topic_vocabulary.sql`, whose sixty fixed literals were written by
 * hand. Sixty-four rows, counted: every topic, three tokens, and the staging canary. §11
 * makes an identifier immutable, so a validator demanding the bits would refuse every topic
 * id and refuse the canary at `POST /v1/tokens`, which is where its credential comes from.
 *
 * The generator is fixed forward and ADR 0014 carries the migration that ends this. Until
 * then `isMintedId` below is the strict form, for values that were never stored rows.
 *
 * Cheap enough to run per request: sixteen bytes of shifting, no allocation worth naming.
 */
export const isOratorId = (value: unknown): value is OratorId => {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return false;
  return encodeId(decodeId(value)) === value;
};

/**
 * §12 in full: an id this platform's generator could have produced, right now.
 *
 * `isOratorId` stops short of the UUIDv7 bits because a stored row predates the fix and §11
 * forbids changing it. That reasoning is about *stored identifiers*. It does not extend to a
 * value a caller hands us for something that was never stored — `X-Request-Id` is the case:
 * §66.1 says UUIDv7, the header is minted fresh by whoever sends it, and there is nothing
 * for it to be backward-compatible with. Accepting `00000000000000000000000000` there was
 * the old check being reused where the reason for its leniency did not apply.
 *
 * When ADR 0014's migration has run this becomes `isOratorId` and this function goes away.
 */
export const isMintedId = (value: unknown): value is OratorId => {
  if (!isOratorId(value)) return false;
  const bytes = decodeId(value);
  return (bytes[6]! >> 4) === 0x7 && (bytes[8]! >> 6) === 0b10;
};

/** Milliseconds since epoch encoded in the leading 48 bits of a UUIDv7. */
export function idTimestamp(id: OratorId): number {
  const bytes = decodeId(id);
  let ms = 0;
  for (let i = 0; i < 6; i++) ms = ms * 256 + bytes[i]!;
  return ms;
}

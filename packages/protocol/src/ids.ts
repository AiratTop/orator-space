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
export const isOratorId = (value: unknown): value is OratorId =>
  typeof value === "string" && ID_PATTERN.test(value);

/** Milliseconds since epoch encoded in the leading 48 bits of a UUIDv7. */
export function idTimestamp(id: OratorId): number {
  const bytes = decodeId(id);
  let ms = 0;
  for (let i = 0; i < 6; i++) ms = ms * 256 + bytes[i]!;
  return ms;
}

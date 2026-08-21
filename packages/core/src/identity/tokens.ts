/**
 * API tokens (SPEC §42.2).
 *
 * The token is shown once and stored only as a SHA-256 hash, so a database disclosure
 * does not hand over working credentials. The prefix is kept in clear purely so a human
 * can tell two tokens apart in a list.
 */

export const TOKEN_PREFIX = "orat_sk";
const SECRET_BYTES = 32;

export interface GeneratedToken {
  /** Shown to the caller exactly once. */
  token: string;
  tokenHash: string;
  /** Safe to display: identifies the token without being usable. */
  prefix: string;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE62[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generateToken(environment: "live" | "test" = "live"): Promise<GeneratedToken> {
  const secret = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(secret);
  const token = `${TOKEN_PREFIX}_${environment}_${base62(secret)}`;
  return { token, tokenHash: await sha256Hex(token), prefix: token.slice(0, 20) };
}

/** Extracts a bearer token, returning null for anything malformed. */
export function bearerFrom(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  const token = match?.[1];
  if (!token || !token.startsWith(`${TOKEN_PREFIX}_`)) return null;
  return token;
}

export const isExpired = (expiresAt: string | null | undefined, now: Date): boolean =>
  expiresAt !== null && expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime();

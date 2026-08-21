/**
 * Agent keys (SPEC §8).
 *
 * These sign content, not requests. Authentication is what tokens are for; what a token
 * cannot do is let a reader verify who wrote an article without trusting the platform.
 * That is the property this exists for, and the reason §8.1 moved signing off the
 * transport in the first place.
 */

export const SIGNATURE_CONTEXT = "orator-revision-v1";
const ALGORITHM = { name: "Ed25519" } as const;

const b64urlToBytes = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const bytesToB64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * The exact bytes a signature covers (SPEC §8.3).
 *
 * A determined string rather than JSON, because JSON has no canonical serialisation
 * without a further specification, and a signature over an ambiguous encoding verifies
 * nothing. The context line comes first so the format can change unambiguously.
 */
export function revisionSigningInput(input: {
  articleId: string;
  revisionId: string;
  contentHash: string;
  createdAt: string;
}): string {
  return [SIGNATURE_CONTEXT, input.articleId, input.revisionId, input.contentHash, input.createdAt].join("\n");
}

/** Challenge/response proof that the registrant holds the private key (SPEC §8.2). */
export function keyRegistrationInput(nonce: string, principalId: string): string {
  return ["orator-key-registration-v1", principalId, nonce].join("\n");
}

export async function fingerprint(publicKeyB64url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", b64urlToBytes(publicKeyB64url));
  return bytesToB64url(new Uint8Array(digest));
}

/**
 * Verifies a signature over `message`. Returns false rather than throwing for malformed
 * input: a bad key or a corrupt signature is an ordinary "no", not an exceptional case,
 * and callers that must branch on it would otherwise wrap every call in a try.
 */
export async function verifySignature(
  publicKeyB64url: string,
  signatureB64url: string,
  message: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", b64urlToBytes(publicKeyB64url), ALGORITHM, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      ALGORITHM,
      key,
      b64urlToBytes(signatureB64url),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/**
 * Was this key usable at the moment it signed?
 *
 * Revocation bounds a key going forward; it does not invalidate what was already signed.
 * Treating revocation as retroactive would let losing a key erase an author's history
 * (SPEC §8.2).
 */
export function keyValidAt(
  key: { createdAt: string; revokedAt?: string | null },
  signedAt: string,
): boolean {
  const at = Date.parse(signedAt);
  if (Number.isNaN(at) || at < Date.parse(key.createdAt)) return false;
  if (key.revokedAt === null || key.revokedAt === undefined) return true;
  return at < Date.parse(key.revokedAt);
}

/** Test helper: generates a key pair in the storage format. */
export async function generateKeyPairForTesting(): Promise<{
  publicKey: string;
  sign: (message: string) => Promise<string>;
}> {
  const pair = (await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    publicKey: bytesToB64url(raw),
    sign: async (message: string) => {
      const signature = await crypto.subtle.sign(ALGORITHM, pair.privateKey, new TextEncoder().encode(message));
      return bytesToB64url(new Uint8Array(signature));
    },
  };
}

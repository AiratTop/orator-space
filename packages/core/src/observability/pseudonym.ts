/**
 * The pseudonym an address is stored as (SPEC §62, §23.4).
 *
 * §62 says an IP address is stored "only as a salted hash", and the salt has to be a secret
 * for that sentence to mean anything. IPv4 is thirty-two bits: a plain `SHA-256(salt + ip)`
 * whose salt is a known string — the environment name, which is what this used to be — is
 * not a pseudonym at all. The whole space is four billion digests, which is minutes of work,
 * so anybody holding a database export holds the addresses. That is the difference between
 * a keyed hash and an unkeyed one, and it is the whole of the protection here.
 *
 * HMAC-SHA-256 with a per-environment secret, therefore. Not a salt column: the value has to
 * be *stable* to be useful — the same caller has to produce the same pseudonym, or the audit
 * log cannot correlate and the flood key (§59.1) cannot count — so it is one secret held
 * outside the data it protects, which is exactly what a pepper is.
 *
 * **Truncated to 128 bits.** Enough that collisions are not a thing that happens, and the
 * column is a correlation handle rather than a value anybody verifies.
 *
 * **Rotating the pepper is a deliberate loss.** Every stored pseudonym becomes uncorrelatable
 * with every new one, which is the right behaviour for the one case that calls for it — the
 * pepper leaked, and the old pseudonyms should stop being pseudonyms of anything.
 */
const PSEUDONYM_HEX = 32;

export async function addressPseudonym(
  address: string | null,
  pepper: string,
): Promise<string | null> {
  if (address === null) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(address));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, PSEUDONYM_HEX);
}

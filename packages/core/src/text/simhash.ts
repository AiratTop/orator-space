/**
 * SimHash over article text (SPEC §60.1).
 *
 * §60.1 names SimHash or MinHash and says what the answer is for: near-duplicate detection
 * affects `indexable` (§50.3) and is a moderation signal, and it **does not block
 * publishing**, because false positives on short news items are inevitable.
 *
 * The property that makes it worth the arithmetic is that similar documents produce similar
 * *hashes* — so "is anything close to this already published" becomes an indexed lookup
 * rather than a comparison against every article. A cryptographic hash cannot do that: one
 * changed word gives a completely unrelated value, which is exactly what a content hash is
 * for (§16.2) and exactly what this is not.
 *
 * In `text/` rather than a domain module because two of them need it — publishing computes
 * it, discovery compares it — and neither may import the other (§27).
 */

const BITS = 64n;
const MASK = (1n << BITS) - 1n;

/** FNV-1a, 64-bit. Not a security primitive; a spread of bits, deterministic across runs. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x0000_0100_0000_01b3n) & MASK;
  }
  return hash;
}

/**
 * Word triples, lower-cased, punctuation dropped.
 *
 * Shingles rather than single words, because a bag of words says two articles on the same
 * subject are the same article. Three is the usual compromise: shorter and every technical
 * article about latency collides, longer and reordering a sentence hides a copy.
 */
function shingles(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .match(/\p{L}[\p{L}\p{N}]*/gu);
  if (words === null || words.length === 0) return [];
  if (words.length < 3) return [words.join(" ")];

  const out: string[] = [];
  for (let i = 0; i + 2 < words.length; i += 1) out.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/**
 * The fingerprint: each bit is the sign of the weighted vote across every shingle.
 *
 * Repeated shingles vote repeatedly, which is deliberate — a document that says the same
 * thing twenty times should look like a document that says it twenty times (§60.1's bulk
 * repetition, from the other direction).
 */
export function simhash(text: string): bigint {
  const votes = new Array<number>(64).fill(0);
  const parts = shingles(text);
  if (parts.length === 0) return 0n;

  for (const shingle of parts) {
    const hash = fnv1a64(shingle);
    for (let bit = 0; bit < 64; bit += 1) {
      votes[bit]! += (hash >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }

  let value = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (votes[bit]! > 0) value |= 1n << BigInt(bit);
  }
  return value;
}

export const toHex = (value: bigint): string => value.toString(16).padStart(16, "0");
export const fromHex = (hex: string): bigint => BigInt(`0x${hex}`);

/** How many bits differ. Two documents are near-duplicates below a small threshold. */
export function hamming(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  while (diff !== 0n) {
    diff &= diff - 1n;
    count += 1;
  }
  return count;
}

/**
 * The threshold, set by measurement rather than by the number everybody quotes.
 *
 * Three is the figure the literature uses, and it is derived from 64-bit fingerprints over
 * web-scale corpora of long documents. Measured against the articles this platform actually
 * holds, it catches almost nothing worth catching:
 *
 * ```text
 * two words changed in a 90-word article        6 bits
 * paragraphs reordered                          4
 * upper-cased and re-wrapped                    0
 * one word changed in a 300-word article        4
 * a genuinely different article, same subject   36
 * ```
 *
 * Short documents produce fewer shingles, so each one carries more of the vote and an edit
 * moves more bits. Seven catches every case above and still leaves a fivefold margin to the
 * nearest honest article — which is the margin that matters, because a false positive here
 * de-indexes somebody's work.
 */
export const NEAR_DUPLICATE = 7;

/**
 * Eight 8-bit bands, so the lookup is an index seek rather than a table scan.
 *
 * The pigeonhole argument is the whole reason this works: if two fingerprints differ in at
 * most seven bits, those seven bits cannot touch all eight bands, so at least one band is
 * identical. Searching by band therefore finds every candidate within the threshold — no
 * false negatives — and the exact distance is computed on the handful of rows that come back.
 *
 * The band count and the threshold are therefore one decision, not two. Eight bands are the
 * consequence of a threshold of seven; raising the threshold again without adding bands
 * would not loosen the check, it would start missing duplicates silently.
 */
export const BANDS = 8;

export const bandsOf = (value: bigint): number[] =>
  Array.from({ length: BANDS }, (_, i) => Number((value >> BigInt(i * 8)) & 0xffn));

export const isNearDuplicate = (a: bigint, b: bigint): boolean => hamming(a, b) <= NEAR_DUPLICATE;

import { describe, expect, it } from "vitest";
import { bandsOf, fromHex, hamming, isNearDuplicate, NEAR_DUPLICATE, simhash, toHex } from "./simhash.js";

/**
 * SPEC §60.1 — the property that makes near-duplicate detection possible at all.
 *
 * A content hash answers "are these byte-identical" and gives an unrelated value for one
 * changed word, which is exactly right for §16.2 and useless here. What this has to do is
 * the opposite: similar documents must produce similar values, or the band lookup finds
 * nothing and the whole mechanism is an expensive no-op.
 */

const ARTICLE = [
  "# Measuring cold start across runtimes",
  "",
  "A hundred invocations per runtime, same payload, same region. The p90 moved from 210 ms",
  "to 340 ms after the deployment on Tuesday, and the first request in each cold path was",
  "consistently slower than the rest by a margin that did not shrink with warm-up.",
  "",
  "The gap is the outbox draining rather than the write path: publishing is a pointer move",
  "and indexing is a queue consumer, so the two are not one latency.",
].join("\n");

describe("similar documents get similar fingerprints", () => {
  it("gives an identical value to identical text", () => {
    expect(simhash(ARTICLE)).toBe(simhash(ARTICLE));
  });

  it("stays within the threshold when a sentence is edited", () => {
    // The case that matters: somebody republishing a copy with a line changed to disguise
    // it. A cryptographic hash would report two unrelated documents.
    const edited = ARTICLE.replace("Tuesday", "Wednesday").replace("340 ms", "345 ms");
    expect(isNearDuplicate(simhash(ARTICLE), simhash(edited))).toBe(true);
  });

  it("stays within the threshold when whitespace and case change", () => {
    const reformatted = ARTICLE.toUpperCase().replace(/\n/g, "\n\n");
    expect(hamming(simhash(ARTICLE), simhash(reformatted))).toBeLessThanOrEqual(NEAR_DUPLICATE);
  });

  it("moves well outside it for a different article on the same subject", () => {
    // False positives here would de-index honest work, so the distance between two genuine
    // articles about latency has to be comfortably above the threshold rather than near it.
    const other = [
      "# What the benchmark does not measure",
      "",
      "One client, one network path, one moment. Taking a single-client figure as a service",
      "level would be a mistake, and saying so is part of publishing it.",
      "",
      "A reader planning a timeout wants the wider of two measurements and a margin; a reader",
      "comparing deployments wants both taken from the same client.",
    ].join("\n");
    expect(hamming(simhash(ARTICLE), simhash(other))).toBeGreaterThan(NEAR_DUPLICATE * 3);
  });

  it("is not fooled by reordering paragraphs", () => {
    const blocks = ARTICLE.split("\n\n");
    const shuffled = [blocks[2], blocks[0], blocks[1]].join("\n\n");
    expect(hamming(simhash(ARTICLE), simhash(shuffled))).toBeLessThanOrEqual(NEAR_DUPLICATE);
  });
});

describe("the banding (§60.1)", () => {
  it("round-trips through hex", () => {
    const value = simhash(ARTICLE);
    expect(fromHex(toHex(value))).toBe(value);
    expect(toHex(value)).toHaveLength(16);
  });

  it("shares a band with anything inside the threshold", () => {
    /*
     * The pigeonhole argument, checked rather than asserted: three differing bits cannot
     * touch four bands, so at least one is identical. This is what makes the lookup an
     * index seek with no false negatives — and what makes raising the threshold past three
     * a silent correctness change rather than a tuning knob.
     */
    const base = simhash(ARTICLE);
    for (let bit = 0n; bit < 64n; bit += 1n) {
      const spread = [bit, (bit + 7n) % 64n, (bit + 13n) % 64n, (bit + 23n) % 64n, (bit + 31n) % 64n, (bit + 41n) % 64n, (bit + 53n) % 64n];
      for (const flips of [[bit], spread.slice(0, 4), spread]) {
        let near = base;
        for (const f of flips) near ^= 1n << f;
        const shared = bandsOf(base).some((band, i) => band === bandsOf(near)[i]);
        expect(shared, `flipping ${flips.join(",")}`).toBe(true);
      }
    }
  });

  it("gives bands that reconstruct the value", () => {
    const value = simhash(ARTICLE);
    const rebuilt = bandsOf(value).reduce((acc, band, i) => acc | (BigInt(band) << BigInt(i * 8)), 0n);
    expect(rebuilt).toBe(value);
  });
});

describe("edge cases", () => {
  it("returns zero for text with no words rather than throwing", () => {
    expect(simhash("")).toBe(0n);
    expect(simhash("   \n\n  ")).toBe(0n);
  });

  it("handles text shorter than one shingle", () => {
    expect(() => simhash("hello")).not.toThrow();
  });
});

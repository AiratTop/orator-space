import type { ContentStore } from "@orator/core/ports";

const PREFIX = "content/";

/** `content_ref` is stored as an opaque string; only this adapter knows its shape. */
export const contentRef = (hash: string): string => `r2:${PREFIX}${hash}`;
export const hashFromRef = (ref: string): string => ref.replace(/^r2:content\//, "");

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Content-addressed body storage (SPEC §16.2).
 *
 * The key is the digest of the content, which makes writes idempotent by construction:
 * storing the same body twice writes identical bytes to the same key. That is what
 * "immutable" means here — not that objects cannot be deleted. Erasure (§23.3) and
 * orphan collection (§32) both must delete, so a retention lock on this bucket would
 * make two required operations impossible (ADR 0001).
 */
export function createR2ContentStore(bucket: R2Bucket): ContentStore {
  return {
    async put(markdown: string): Promise<string> {
      const hash = await sha256Hex(markdown);
      const key = PREFIX + hash;

      // Two different bodies cannot collide on one key, so an existing object is already
      // byte-identical. Skipping the write saves a class-A operation on every republish
      // of unchanged content, which revision history makes common.
      if ((await bucket.head(key)) === null) {
        await bucket.put(key, markdown, {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
          customMetadata: { sha256: hash },
        });
      }
      return hash;
    },

    async get(contentHash: string): Promise<string | null> {
      const object = await bucket.get(PREFIX + contentHash);
      return object === null ? null : await object.text();
    },

    /**
     * Callers MUST establish that no surviving revision references this hash before
     * calling. Bodies are deduplicated across articles and authors, so an unchecked
     * delete during erasure destroys someone else's article (§23.3).
     */
    async delete(contentHash: string): Promise<void> {
      await bucket.delete(PREFIX + contentHash);
    },
  };
}

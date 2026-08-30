import type { ContentStore } from "../ports/index.js";

/**
 * In-memory ContentStore for domain tests.
 *
 * Its existence is the point of SPEC §28.1: the domain is testable without Miniflare,
 * without a bucket, and without Cloudflare types anywhere near it. If a domain test ever
 * needs the real adapter, the ports boundary has been broken.
 */
export function createMemoryContentStore(
  now: () => Date = () => new Date(),
): ContentStore & { size(): number; setUploadedAt(contentHash: string, at: string): void } {
  const objects = new Map<string, string>();
  /** The store's own timestamps, which §32.2's grace period reads. */
  const uploaded = new Map<string, string>();

  const sha256Hex = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  return {
    async put(markdown) {
      const hash = await sha256Hex(markdown);
      objects.set(hash, markdown);
      if (!uploaded.has(hash)) uploaded.set(hash, now().toISOString());
      return hash;
    },
    async get(contentHash) {
      return objects.get(contentHash) ?? null;
    },
    async delete(contentHash) {
      objects.delete(contentHash);
      uploaded.delete(contentHash);
    },
    async deleteMany(contentHashes) {
      for (const hash of contentHashes) {
        objects.delete(hash);
        uploaded.delete(hash);
      }
    },
    async list({ cursor = null, limit }) {
      // Sorted, so paging is stable — R2 lists lexicographically by key and the collector
      // depends on that to make progress across passes.
      const keys = [...objects.keys()].sort();
      const from = cursor === null ? 0 : keys.findIndex((key) => key > cursor);
      const page = from === -1 ? [] : keys.slice(from, from + limit);
      return {
        objects: page.map((contentHash) => ({
          contentHash,
          uploadedAt: uploaded.get(contentHash) ?? new Date(0).toISOString(),
        })),
        cursor: from !== -1 && from + limit < keys.length ? (page.at(-1) ?? null) : null,
      };
    },
    refFor: (contentHash) => `r2:content/${contentHash}`,
    size: () => objects.size,
    setUploadedAt: (contentHash, at) => uploaded.set(contentHash, at),
  };
}

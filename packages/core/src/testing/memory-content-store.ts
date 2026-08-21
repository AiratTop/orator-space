import type { ContentStore } from "../ports/index.js";

/**
 * In-memory ContentStore for domain tests.
 *
 * Its existence is the point of SPEC §28.1: the domain is testable without Miniflare,
 * without a bucket, and without Cloudflare types anywhere near it. If a domain test ever
 * needs the real adapter, the ports boundary has been broken.
 */
export function createMemoryContentStore(): ContentStore & { size(): number } {
  const objects = new Map<string, string>();

  const sha256Hex = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  return {
    async put(markdown) {
      const hash = await sha256Hex(markdown);
      objects.set(hash, markdown);
      return hash;
    },
    async get(contentHash) {
      return objects.get(contentHash) ?? null;
    },
    async delete(contentHash) {
      objects.delete(contentHash);
    },
    size: () => objects.size,
  };
}

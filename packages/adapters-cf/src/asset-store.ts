import type { AssetStore } from "@orator/core/ports";

/**
 * Generated files in R2 (SPEC §51, PLAN §1.1).
 *
 * The `assets` bucket, and the one bucket in this architecture whose objects are rewritten
 * in place. `content` is addressed by hash and therefore never changes; `media` is what
 * somebody uploaded. What lives here is derived from the database, so replacing an object
 * is the normal case rather than a loss.
 *
 * No custom domain of its own (PLAN §1.6): the apex serves these through a binding, so one
 * body of code serves both environments and the bucket stays private.
 */
export function createR2AssetStore(bucket: R2Bucket): AssetStore {
  return {
    async put(key: string, body: string, contentType: string): Promise<void> {
      await bucket.put(key, body, {
        httpMetadata: {
          contentType,
          // Cached at the edge for a few minutes, because the file is rebuilt on a
          // five-minute cron and a crawler fetching a ten-minute-old sitemap has lost
          // nothing. The header travels with the object, so the worker serving it does not
          // have to remember to set one.
          cacheControl: "public, max-age=300",
        },
      });
    },

    async get(key: string): Promise<string | null> {
      const object = await bucket.get(key);
      return object === null ? null : await object.text();
    },
  };
}

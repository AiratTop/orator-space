import type { ShardKey, ShardState, SitemapArticle, SitemapRepo } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";

/** SPEC §51 over D1 (ADR 0009). One row per month, not one per article. */
interface ShardRow {
  shard: string;
  url_count: number;
  built_at: string | null;
}

interface ArticleRow {
  id: string;
  published_at: string;
  updated_at: string;
}

/**
 * What may appear in a sitemap (SPEC §51, §15.1).
 *
 * Written once, here, rather than repeated at each call site. Every condition is a rule
 * from somewhere else: published and public are §51's, `indexable = 1` is §50.3's earned
 * state, and the missing `canonical_url` is §15.1 — a cross-post's primary copy belongs to
 * somebody else, and submitting ours puts two copies of one text into the same index.
 *
 * The last is §66.7's, and it was missing until the canary was first run against staging.
 * The sitemap is named there as one of the five places the exclusion is enforced, and it is
 * the one where the omission is worst: the canary publishes every few minutes and removes
 * what it published within seconds, so a rebuild landing in that window submits a URL to
 * search engines that is a tombstone by the time anything follows it.
 */
const ELIGIBLE = `
  status = 'published'
  AND visibility = 'public'
  AND indexable = 1
  AND canonical_url IS NULL
  AND published_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM principals
               WHERE principals.id = articles.author_principal_id
                 AND principals.system_account = 0)
`;

export function createSitemapRepo(db: D1Database): SitemapRepo {
  return {
    async markDirty(shard: ShardKey): Promise<void> {
      /*
       * Idempotent, because queue delivery is (§34.2). The same event arriving twice must
       * mark the shard dirty and not schedule a second rebuild — which is what the upsert
       * gives, since dirty is a state rather than a count.
       */
      await db
        .prepare(
          `INSERT INTO sitemap_shards (kind, shard, dirty) VALUES ('articles', ?, 1)
           ON CONFLICT (kind, shard) DO UPDATE SET dirty = 1`,
        )
        .bind(shard)
        .run();
    },

    async dirtyShards(limit: number): Promise<ShardKey[]> {
      const { results } = await db
        .prepare(
          `SELECT shard FROM sitemap_shards
           WHERE kind = 'articles' AND dirty = 1
           ORDER BY shard DESC LIMIT ?`,
        )
        .bind(limit)
        .all<{ shard: string }>();
      // Newest first: the month being published into is the one a crawler is most likely to
      // be asking about, and it is the one that will be dirty again in five minutes.
      return results.map((row) => row.shard);
    },

    async articlesIn(shard: ShardKey, limit: number): Promise<SitemapArticle[]> {
      const { results } = await db
        .prepare(
          `SELECT id, published_at, updated_at FROM articles
           WHERE substr(published_at, 1, 7) = ? AND ${ELIGIBLE}
           ORDER BY published_at DESC LIMIT ?`,
        )
        .bind(shard, limit)
        .all<ArticleRow>();

      return results.map((row) => ({
        id: row.id as OratorId,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
      }));
    },

    async markBuilt(shard: ShardKey, urlCount: number, at: string): Promise<void> {
      /*
       * `dirty = 0` only for the shard as it was read.
       *
       * A publication that lands between the read and this write leaves the row dirty
       * again, and the next run picks it up. The alternative — clearing the flag first —
       * loses that article from the sitemap until something else in the same month changes,
       * which could be a month.
       */
      await db
        .prepare(
          `UPDATE sitemap_shards SET dirty = 0, url_count = ?, built_at = ?
           WHERE kind = 'articles' AND shard = ?`,
        )
        .bind(urlCount, at, shard)
        .run();
    },

    async shards(): Promise<ShardState[]> {
      const { results } = await db
        .prepare(
          `SELECT shard, url_count, built_at FROM sitemap_shards
           WHERE kind = 'articles' ORDER BY shard DESC`,
        )
        .all<ShardRow>();

      return results.map((row) => ({
        shard: row.shard,
        urlCount: row.url_count,
        builtAt: row.built_at,
      }));
    },
  };
}

import type { OratorId } from "@orator/protocol";

/**
 * The sitemap's storage (SPEC §51, ADR 0009).
 *
 * Two ports, because two things are stored in two places and only one of them is a
 * database. `SitemapRepo` holds which shards need rebuilding; `AssetStore` holds the files
 * a crawler fetches. Keeping the second one narrow — put and get, keyed by a path — is what
 * lets the apex serve a sitemap without the web app gaining a way to write anything else.
 */

/** A shard is one month of publications: `2026-08`. */
export type ShardKey = string;

export interface ShardState {
  shard: ShardKey;
  urlCount: number;
  builtAt: string | null;
}

/** One published article, as much of it as a `<url>` entry needs. */
export interface SitemapArticle {
  id: OratorId;
  publishedAt: string;
  updatedAt: string;
}

export interface SitemapRepo {
  /**
   * Marks the shard a change belongs to. Called from the event handler, so it must be
   * idempotent: at-least-once delivery means the same event arrives twice, and dirtying an
   * already-dirty shard has to be a no-op rather than a second rebuild.
   */
  markDirty(shard: ShardKey): Promise<void>;
  dirtyShards(limit: number): Promise<ShardKey[]>;
  /** Eligibility is §51's, plus §15.1: a cross-post never enters the sitemap. */
  articlesIn(shard: ShardKey, limit: number): Promise<SitemapArticle[]>;
  markBuilt(shard: ShardKey, urlCount: number, at: string): Promise<void>;
  /** Every shard that has ever been built, for the index. */
  shards(): Promise<ShardState[]>;
}

/**
 * SPEC §51 — generated files in R2: sitemaps today, exports later (§53).
 *
 * Rewritten in place rather than versioned, which is the difference between this bucket and
 * `content`: an object here is derived from the database and is replaced whenever the thing
 * it was derived from moves.
 */
export interface AssetStore {
  put(key: string, body: string, contentType: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

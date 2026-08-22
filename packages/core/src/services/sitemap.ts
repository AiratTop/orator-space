import { canonicalPath } from "../articles/urls.js";
import type { ArticleRepo, AssetStore, Clock, ShardKey, SitemapArticle, SitemapRepo } from "../ports/index.js";

/**
 * The sitemap (SPEC §51, ADR 0009).
 *
 * Two halves that meet through one table. The event handler marks the shard an article
 * belongs to; a cron rebuilds the shards that are marked. Neither builds anything on
 * request — §51 is explicit that generating on demand is a read of the whole table on every
 * crawler visit, and a crawler visits far more often than a person imagines.
 *
 * A shard is one month of publications. The reasoning is in ADR 0009, and the short version
 * is that an ordinal key cannot be computed from the row the handler is already holding: it
 * would have to count every article published before this one, on every event.
 */

export type SitemapPorts = {
  sitemap: SitemapRepo;
  assets: AssetStore;
  articles: ArticleRepo;
  clock: Clock;
};

/** §51. A month is far below it at any rate this project will see before revisiting. */
export const MAX_URLS_PER_SHARD = 50_000;

/** How many shards one rebuild may touch. Bounded for the same reason retention is (§23.4). */
const SHARDS_PER_RUN = 12;

export const INDEX_KEY = "sitemap.xml";
export const PAGES_KEY = "sitemaps/pages.xml";
export const shardObjectKey = (shard: ShardKey): string => `sitemaps/articles-${shard}.xml`;

/**
 * The site's own pages (SPEC §50.1).
 *
 * A separate shard, and the only one that is not derived from the database. These four are
 * written in this repository rather than published to the platform, so nothing about them is
 * earned or revoked — §50.3's rule is about articles, and its reason (a domain judged on the
 * pattern of machine-generated content at volume) does not reach a page a person wrote.
 *
 * It is also what keeps the sitemap from being empty. A network whose articles have not yet
 * earned indexing still has a front door and three policies, and an index listing nothing is
 * a file no crawler should have been pointed at.
 *
 * No `lastmod`. It is optional, and the alternative available here is the build time, which
 * would tell a crawler these pages change every five minutes.
 */
export const STATIC_PAGES = ["/", "/terms", "/privacy", "/content-policy"] as const;

/** `2026-08-22T…` → `2026-08`. The shard key, and the only place it is decided. */
export const shardOf = (publishedAt: string): ShardKey => publishedAt.slice(0, 7);

/**
 * Marks the shard an article's change belongs to.
 *
 * Reads the article rather than trusting the event to carry a date, for the reason every
 * other handler does: at-least-once delivery means the event may be a replay, and current
 * state is the only thing that is true twice.
 *
 * An article that was never published has no month and no shard. Silence is the right
 * answer — a draft is not missing from the sitemap, it is not eligible for it.
 */
export async function markArticleShard(ports: SitemapPorts, articleId: string): Promise<ShardKey | null> {
  const article = await ports.articles.findById(articleId);
  if (article === null || article.publishedAt === null) return null;

  const shard = shardOf(article.publishedAt);
  await ports.sitemap.markDirty(shard);
  return shard;
}

export interface SitemapBuild {
  shardsBuilt: number;
  urls: number;
  /** Shards left dirty because the run's budget was spent. Non-zero means "run again". */
  remaining: number;
  /** A shard at or over §51's limit. ADR 0009's escape hatch is a day-level key. */
  overflowing: ShardKey[];
  /** Whether the static page shard changed, which is how a new page reaches the index. */
  pagesRewritten: boolean;
}

/**
 * Rebuilds every dirty shard, then the index.
 *
 * Does nothing at all when nothing is dirty, which is what makes a five-minute schedule
 * cheap: the whole cost of a quiet period is one indexed query against a table with one row
 * per month.
 */
export async function rebuildSitemap(ports: SitemapPorts, siteOrigin: string): Promise<SitemapBuild> {
  const build: SitemapBuild = { shardsBuilt: 0, urls: 0, remaining: 0, overflowing: [], pagesRewritten: false };

  /*
   * The static shard first, and by comparison rather than on a flag.
   *
   * There is no event that fires when a page is added to this repository, so a dirty flag
   * would be a flag nobody sets. Reading the file and comparing costs one small R2 get per
   * run and makes the list in the code the thing that decides — add a page, and the next
   * cron writes it.
   */
  const pages = renderPages(siteOrigin);
  if ((await ports.assets.get(PAGES_KEY)) !== pages) {
    await ports.assets.put(PAGES_KEY, pages, "application/xml");
    build.pagesRewritten = true;
  }

  const dirty = await ports.sitemap.dirtyShards(SHARDS_PER_RUN + 1);
  const indexExists = (await ports.assets.get(INDEX_KEY)) !== null;
  if (dirty.length === 0 && indexExists && !build.pagesRewritten) return build;

  const remaining = dirty.slice(SHARDS_PER_RUN);
  build.remaining = remaining.length;

  const now = ports.clock.now().toISOString();
  for (const shard of dirty.slice(0, SHARDS_PER_RUN)) {
    const articles = await ports.sitemap.articlesIn(shard, MAX_URLS_PER_SHARD);
    if (articles.length >= MAX_URLS_PER_SHARD) build.overflowing.push(shard);

    await ports.assets.put(shardObjectKey(shard), renderUrlset(articles, siteOrigin), "application/xml");
    await ports.sitemap.markBuilt(shard, articles.length, now);
    build.shardsBuilt += 1;
    build.urls += articles.length;
  }

  /*
   * The index last, and always.
   *
   * A shard that emptied — every article in that month unpublished, or made unindexable —
   * has to leave the index, and the only way to know that is to rebuild it from the table
   * after the shards have written their counts.
   */
  const shards = (await ports.sitemap.shards()).filter((state) => state.urlCount > 0);
  await ports.assets.put(INDEX_KEY, renderIndex(shards, siteOrigin), "application/xml");
  return build;
}

/** The static shard: the site's own pages, which are always there. */
export function renderPages(siteOrigin: string): string {
  const urls = STATIC_PAGES.map((path) => `  <url>\n    <loc>${escapeXml(siteOrigin + path)}</loc>\n  </url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * XML escaping.
 *
 * A slug is derived from a title an untrusted party wrote, and a sitemap is XML that a
 * crawler parses strictly: one unescaped `&` invalidates the document, so every article
 * silently leaves the index because one of them had an ampersand in its title.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderUrlset(articles: SitemapArticle[], siteOrigin: string): string {
  const urls = articles.map((article) => {
    const loc = escapeXml(`${siteOrigin}${canonicalPath(article)}`);
    // `lastmod` is when the article last changed, not when it was published: a crawler uses
    // it to decide whether to fetch again, and the publication date answers a question it
    // did not ask.
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${escapeXml(article.updatedAt)}</lastmod>\n  </url>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

export function renderIndex(
  shards: { shard: ShardKey; builtAt: string | null }[],
  siteOrigin: string,
): string {
  // The static shard is always listed and always first: it is the part of the sitemap that
  // does not depend on anybody having published anything.
  const entries = [`  <sitemap>\n    <loc>${escapeXml(`${siteOrigin}/${PAGES_KEY}`)}</loc>\n  </sitemap>`];
  entries.push(...shards.map((state) => {
    const loc = escapeXml(`${siteOrigin}/${shardObjectKey(state.shard)}`);
    const lastmod = state.builtAt === null ? "" : `\n    <lastmod>${escapeXml(state.builtAt)}</lastmod>`;
    return `  <sitemap>\n    <loc>${loc}</loc>${lastmod}\n  </sitemap>`;
  }));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</sitemapindex>",
    "",
  ].join("\n");
}

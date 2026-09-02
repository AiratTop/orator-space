import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, publishArticle } from "./publishing.js";
import { unpublishArticle } from "./publishing.js";
import {
  escapeXml,
  INDEX_KEY,
  PAGES_KEY,
  renderPages,
  STATIC_PAGES,
  markArticleShard,
  rebuildSitemap,
  renderIndex,
  renderUrlset,
  shardObjectKey,
  shardOf,
  TOPICS_KEY,
} from "./sitemap.js";
import { INDEXABLE_THRESHOLD } from "./topics.js";

let ports: ReturnType<typeof createMemoryPorts>;

const AUTHOR = "AGENT-A";
const OWNER = "OWNER-H";
const SITE = "https://orator.space";

const actor: Actor = {
  principalId: AUTHOR,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: OWNER,
  status: "active",
  trustLevel: 1,
  systemAccount: false,
};

const ctx = (): RequestContext => ({
  ports,
  requestId: "REQ",
  actor,
  tokenId: null,
  ipHash: null,
  userAgent: null,
  audience: "agent_api",
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};

const principal = (id: string, username: string, extra: Record<string, unknown> = {}) => ({
  id: id as never,
  kind: "human" as const,
  username,
  usernameSkeleton: username,
  displayName: null,
  bio: null,
  status: "active" as const,
  platformRole: "user" as const,
  systemAccount: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

/** Publishes, and grants the indexable state the sitemap requires (§50.3). */
async function publish(title: string, options: { indexable?: boolean } = {}): Promise<string> {
  const draft = unwrap(await createArticle(ctx(), { title, content: `# ${title}\n\nBody.\n` }));
  unwrap(await publishArticle(ctx(), draft.id));
  const article = ports.state.articles.get(draft.id)!;
  ports.state.articles.set(draft.id, { ...article, indexable: options.indexable ?? true });
  return draft.id;
}

beforeEach(() => {
  ports = createMemoryPorts();
  ports.setNow(new Date("2026-08-15T10:00:00.000Z"));
  ports.state.principals.set(OWNER, principal(OWNER, "owner"));
  ports.state.principals.set(AUTHOR, principal(AUTHOR, "researcher", { kind: "agent", ownerPrincipalId: OWNER }));
});

describe("the shard key (ADR 0009)", () => {
  it("is the publication month", () => {
    expect(shardOf("2026-08-15T10:00:00.000Z")).toBe("2026-08");
    expect(shardOf("2019-01-01T00:00:00.000Z")).toBe("2019-01");
  });

  it("names one file per month", () => {
    expect(shardObjectKey("2026-08")).toBe("sitemaps/articles-2026-08.xml");
  });
});

describe("marking a shard (SPEC §51)", () => {
  it("marks the month the article was published in, not the month it changed", async () => {
    const id = await publish("First");
    // The article claims August; the change happens in September.
    ports.setNow(new Date("2026-09-02T00:00:00.000Z"));

    expect(await markArticleShard(ports, id)).toBe("2026-08");
    expect(await ports.sitemap.dirtyShards(10)).toEqual(["2026-08"]);
  });

  it("says nothing about an article that was never published", async () => {
    const draft = unwrap(await createArticle(ctx(), { title: "Draft", content: "# Draft\n\nx\n" }));
    expect(await markArticleShard(ports, draft.id)).toBeNull();
    expect(await ports.sitemap.dirtyShards(10)).toEqual([]);
  });

  it("says nothing about the canary's article, which is not in the sitemap (§66.7)", async () => {
    // It publishes and removes one every few minutes. Marking on each would leave a shard
    // dirty at all times, and a rebuild with nothing to do is what makes the cron cheap.
    const canary = "SYSTEM-CANARY";
    ports.state.principals.set(
      canary,
      principal(canary, "canary-staging", { kind: "agent", ownerPrincipalId: OWNER, systemAccount: true }),
    );
    const draft = unwrap(
      await createArticle({ ...ctx(), actor: { ...actor, principalId: canary, systemAccount: true } }, {
        title: "Deep health check",
        content: "# Deep health check\n\nBody.\n",
      }),
    );
    unwrap(await publishArticle({ ...ctx(), actor: { ...actor, principalId: canary, systemAccount: true } }, draft.id));

    expect(await markArticleShard(ports, draft.id)).toBeNull();
    expect(await ports.sitemap.dirtyShards(10)).toEqual([]);
  });

  it("is idempotent, because queue delivery is at-least-once", async () => {
    const id = await publish("First");
    await markArticleShard(ports, id);
    await markArticleShard(ports, id);
    expect(await ports.sitemap.dirtyShards(10)).toEqual(["2026-08"]);
  });
});

describe("rebuilding (SPEC §51)", () => {
  it("still writes the site's own pages when nothing has been published", async () => {
    const build = await rebuildSitemap(ports, SITE);
    expect(build.shardsBuilt).toBe(0);
    expect(build.pagesRewritten).toBe(true);

    // The whole point: an index that names something on a network with no articles in it.
    expect(ports.state.assets.get(PAGES_KEY)).toContain(`${SITE}/terms`);
    expect(ports.state.assets.get(INDEX_KEY)).toContain(`${SITE}/${PAGES_KEY}`);
  });

  it("does nothing on a second run, because nothing changed", async () => {
    await rebuildSitemap(ports, SITE);
    const again = await rebuildSitemap(ports, SITE);
    expect(again).toEqual({
      shardsBuilt: 0,
      urls: 0,
      remaining: 0,
      overflowing: [],
      pagesRewritten: false,
      topicsRewritten: false,
      topicUrls: 0,
    });
  });

  it("rewrites the page shard when the list in the code changes", async () => {
    // What a deployment before a page was added looks like from here.
    ports.state.assets.set(PAGES_KEY, renderPages(SITE).replace(`  <url>\n    <loc>${SITE}/terms</loc>\n  </url>\n`, ""));
    const build = await rebuildSitemap(ports, SITE);

    expect(build.pagesRewritten).toBe(true);
    expect(ports.state.assets.get(PAGES_KEY)).toContain(`${SITE}/terms`);
  });

  it("writes one file per month and an index naming them", async () => {
    const august = await publish("August");
    ports.setNow(new Date("2026-09-04T09:00:00.000Z"));
    const september = await publish("September");

    await markArticleShard(ports, august);
    await markArticleShard(ports, september);
    const build = await rebuildSitemap(ports, SITE);

    expect(build.shardsBuilt).toBe(2);
    expect(build.urls).toBe(2);
    expect(ports.state.assets.get("sitemaps/articles-2026-08.xml")).toContain(`${SITE}/p/${august}`);
    expect(ports.state.assets.get("sitemaps/articles-2026-09.xml")).toContain(`${SITE}/p/${september}`);

    const index = ports.state.assets.get(INDEX_KEY)!;
    expect(index).toContain(`${SITE}/sitemaps/articles-2026-08.xml`);
    expect(index).toContain(`${SITE}/sitemaps/articles-2026-09.xml`);
    expect(index).toContain(`${SITE}/${PAGES_KEY}`);
  });

  it("clears the flag, so a second run does nothing", async () => {
    await markArticleShard(ports, await publish("First"));
    await rebuildSitemap(ports, SITE);
    expect((await rebuildSitemap(ports, SITE)).shardsBuilt).toBe(0);
  });

  it("leaves out an article that has not earned indexing (§50.3)", async () => {
    const id = await publish("Unindexable", { indexable: false });
    await markArticleShard(ports, id);
    await rebuildSitemap(ports, SITE);

    expect(ports.state.assets.get("sitemaps/articles-2026-08.xml")).not.toContain(id);
  });

  it("leaves out the canary's article, however the shard came to be rebuilt (§66.7)", async () => {
    // The marking is skipped, so the ordinary way this file is written does not include it.
    // This is the other half: a shard dirtied by a real article must not carry the canary's
    // URL along with it. §66.7 calls the exclusion a column rather than a convention because
    // it has to hold in five places, and this is the one a crawler reads.
    const canaryCtx = { ...ctx(), actor: { ...actor, principalId: "SYSTEM-CANARY", systemAccount: true } };
    ports.state.principals.set(
      "SYSTEM-CANARY",
      principal("SYSTEM-CANARY", "canary-staging", {
        kind: "agent",
        ownerPrincipalId: OWNER,
        systemAccount: true,
      }),
    );
    const probe = unwrap(
      await createArticle(canaryCtx, { title: "Deep health check", content: "# Deep health check\n\nBody.\n" }),
    );
    unwrap(await publishArticle(canaryCtx, probe.id));
    ports.state.articles.set(probe.id, { ...ports.state.articles.get(probe.id)!, indexable: true });

    const real = await publish("Written by a person");
    await markArticleShard(ports, real);
    await rebuildSitemap(ports, SITE);

    const shard = ports.state.assets.get("sitemaps/articles-2026-08.xml")!;
    expect(shard).toContain(`${SITE}/p/${real}`);
    expect(shard).not.toContain(probe.id);
  });

  it("leaves out a cross-post, whose primary copy is somebody else's (§15.1)", async () => {
    const id = await publish("Cross-posted");
    const article = ports.state.articles.get(id)!;
    ports.state.articles.set(id, { ...article, canonicalUrl: "https://elsewhere.test/x" });

    await markArticleShard(ports, id);
    await rebuildSitemap(ports, SITE);
    expect(ports.state.assets.get("sitemaps/articles-2026-08.xml")).not.toContain(id);
  });

  it("removes an emptied month from the index rather than leaving it listed", async () => {
    const id = await publish("Withdrawn");
    await markArticleShard(ports, id);
    await rebuildSitemap(ports, SITE);
    expect(ports.state.assets.get(INDEX_KEY)).toContain("articles-2026-08.xml");

    unwrap(await unpublishArticle(ctx(), id));
    await markArticleShard(ports, id);
    await rebuildSitemap(ports, SITE);

    // The shard file is written and empty; the index no longer points at it, which is what
    // a crawler reads. The site's own pages stay, which is why the index is never empty.
    expect(ports.state.assets.get(INDEX_KEY)).not.toContain("articles-2026-08.xml");
    expect(ports.state.assets.get(INDEX_KEY)).toContain(PAGES_KEY);
  });
});

describe("the XML", () => {
  it("escapes what XML requires escaping", () => {
    expect(escapeXml(`a&b<c>"d"'e'`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
  });

  it("produces a urlset with a lastmod per entry", () => {
    const xml = renderUrlset(
      [{ id: "ID" as never, publishedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" }],
      SITE,
    );
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<loc>${SITE}/p/ID</loc>`);
    // `lastmod` is when it last changed, not when it was published.
    expect(xml).toContain("<lastmod>2026-08-02T00:00:00.000Z</lastmod>");
  });

  it("puts nothing in a <loc> that anybody wrote (ADR 0010)", () => {
    const xml = renderUrlset(
      [{ id: "ID" as never, publishedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }],
      SITE,
    );
    // A `<loc>` used to end in a slug derived from an author's title, and one unescaped `&`
    // invalidates the document — every article in the month with it. Now the whole address
    // is an origin and an id, and the escaping below is a guard rather than a load-bearing
    // step.
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("lists every one of the site's own pages, with no lastmod to invent", () => {
    const xml = renderPages(SITE);
    for (const path of STATIC_PAGES) expect(xml).toContain(`<loc>${SITE}${path}</loc>`);
    expect(xml).not.toContain("<lastmod>");
  });

  it("produces an index of shards", () => {
    const xml = renderIndex([{ shard: "2026-08", builtAt: "2026-08-15T10:00:00.000Z" }], SITE);
    expect(xml).toContain("<sitemapindex");
    expect(xml).toContain(`<loc>${SITE}/${PAGES_KEY}</loc>`);
    expect(xml).toContain(`<loc>${SITE}/sitemaps/articles-2026-08.xml</loc>`);
    expect(xml).toContain("<lastmod>2026-08-15T10:00:00.000Z</lastmod>");
  });
});

/**
 * SPEC §51, §22.1 — the topic shard.
 *
 * The threshold is the whole behaviour, so the tests are written around it rather than
 * around the file: below it nothing is submitted and the index does not name a shard, at it
 * the page appears. Written by comparison rather than a dirty flag, so a run that changes
 * nothing must also write nothing.
 */
describe("the topic shard", () => {
  const topic = (id: string, slug: string) =>
    ports.state.topics.set(id, {
      id: id as never,
      slug,
      label: slug,
      description: null,
      parentSlug: null,
      status: "active" as const,
    });

  const classify = (topicId: string, articleIds: string[]) =>
    ports.state.articleTopics.set(topicId, new Set(articleIds));

  const indexableArticles = (n: number): string[] => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `ART-${i}`;
      ports.state.articles.set(id, {
        id,
        status: "published",
        visibility: "public",
        indexable: true,
        publishedAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      } as never);
      ids.push(id);
    }
    return ids;
  };

  it("submits nothing below the threshold, and names no shard for it", async () => {
    topic("T-LLM", "llm");
    classify("T-LLM", indexableArticles(INDEXABLE_THRESHOLD - 1));

    const build = await rebuildSitemap(ports, SITE);
    expect(build.topicUrls).toBe(0);
    expect(ports.state.assets.get(TOPICS_KEY) ?? "").toBe("");
    expect(ports.state.assets.get(INDEX_KEY)).not.toContain(TOPICS_KEY);
  });

  it("submits the page once it holds enough, and names the shard", async () => {
    topic("T-LLM", "llm");
    classify("T-LLM", indexableArticles(INDEXABLE_THRESHOLD));

    const build = await rebuildSitemap(ports, SITE);
    expect(build.topicUrls).toBe(1);
    expect(build.topicsRewritten).toBe(true);
    expect(ports.state.assets.get(TOPICS_KEY)).toContain(`${SITE}/t/llm`);
    expect(ports.state.assets.get(INDEX_KEY)).toContain(`${SITE}/${TOPICS_KEY}`);
  });

  it("writes nothing on a second run, because the file did not change", async () => {
    topic("T-LLM", "llm");
    classify("T-LLM", indexableArticles(INDEXABLE_THRESHOLD));

    await rebuildSitemap(ports, SITE);
    expect((await rebuildSitemap(ports, SITE)).topicsRewritten).toBe(false);
  });

  it("counts only what the site vouches for, not everything published", async () => {
    topic("T-LLM", "llm");
    const ids = indexableArticles(INDEXABLE_THRESHOLD);
    // §50.3 — indexing is earned. Three articles the site has told crawlers to ignore are
    // not three reasons to submit the page listing them.
    for (const id of ids) {
      ports.state.articles.set(id, { ...ports.state.articles.get(id)!, indexable: false } as never);
    }
    classify("T-LLM", ids);

    expect((await rebuildSitemap(ports, SITE)).topicUrls).toBe(0);
  });
});

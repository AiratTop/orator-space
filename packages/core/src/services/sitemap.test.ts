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
  markArticleShard,
  rebuildSitemap,
  renderIndex,
  renderUrlset,
  shardObjectKey,
  shardOf,
} from "./sitemap.js";

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

  it("is idempotent, because queue delivery is at-least-once", async () => {
    const id = await publish("First");
    await markArticleShard(ports, id);
    await markArticleShard(ports, id);
    expect(await ports.sitemap.dirtyShards(10)).toEqual(["2026-08"]);
  });
});

describe("rebuilding (SPEC §51)", () => {
  it("does nothing at all when no shard is dirty", async () => {
    const build = await rebuildSitemap(ports, SITE);
    expect(build).toEqual({ shardsBuilt: 0, urls: 0, remaining: 0, overflowing: [] });
    expect(ports.state.assets.size).toBe(0);
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
    // a crawler reads.
    expect(ports.state.assets.get(INDEX_KEY)).not.toContain("articles-2026-08.xml");
  });
});

describe("the XML", () => {
  it("escapes what an untrusted title put in a slug", () => {
    expect(escapeXml(`a&b<c>"d"'e'`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
  });

  it("produces a urlset with a lastmod per entry", () => {
    const xml = renderUrlset(
      [{ id: "ID" as never, slug: "title", publishedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" }],
      SITE,
    );
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<loc>${SITE}/p/ID/title</loc>`);
    // `lastmod` is when it last changed, not when it was published.
    expect(xml).toContain("<lastmod>2026-08-02T00:00:00.000Z</lastmod>");
  });

  it("survives a slug carrying an ampersand", () => {
    const xml = renderUrlset(
      [{ id: "ID" as never, slug: "this&that", publishedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }],
      SITE,
    );
    // One unescaped `&` invalidates the document, and every article in the month goes with it.
    expect(xml).toContain("this&amp;that");
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("produces an index of shards", () => {
    const xml = renderIndex([{ shard: "2026-08", builtAt: "2026-08-15T10:00:00.000Z" }], SITE);
    expect(xml).toContain("<sitemapindex");
    expect(xml).toContain(`<loc>${SITE}/sitemaps/articles-2026-08.xml</loc>`);
    expect(xml).toContain("<lastmod>2026-08-15T10:00:00.000Z</lastmod>");
  });
});

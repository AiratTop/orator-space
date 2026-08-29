import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, publishArticle, unpublishArticle } from "./publishing.js";
import { feed, MAX_INDEXED_BODY_BYTES, reindexArticle, search, searchPrincipals, truncateForIndex } from "./discovery.js";

let ports: ReturnType<typeof createMemoryPorts>;

const AUTHOR = "AGENT-A";
const OWNER = "OWNER-H";

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

async function publish(title: string, content: string): Promise<string> {
  const draft = unwrap(await createArticle(ctx(), { title, content }));
  unwrap(await publishArticle(ctx(), draft.id));
  return draft.id;
}

beforeEach(() => {
  ports = createMemoryPorts();
  ports.state.principals.set(OWNER, principal(OWNER, "owner"));
  ports.state.principals.set(AUTHOR, principal(AUTHOR, "researcher", { kind: "agent", ownerPrincipalId: OWNER }));
});

describe("indexing (SPEC §38.1)", () => {
  it("does not index at publication time — the index is updated by the event handler", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations per runtime.\n");
    // §34.4 is a promise to agents, and this is what makes it true rather than incidental.
    expect(await ports.search.indexedHash(id)).toBeNull();
    expect(unwrap(await search(ports, "invocations")).articles).toHaveLength(0);
  });

  it("indexes when the handler runs, and finds the article by its body", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations per runtime.\n");
    expect(await reindexArticle(ports, id)).toBe("indexed");

    const found = unwrap(await search(ports, "invocations"));
    expect(found.articles.map((card) => card.id)).toEqual([id]);
  });

  it("is idempotent, because queue delivery is at-least-once", async () => {
    const id = await publish("Cold start", "# Cold start\n\nBody.\n");
    expect(await reindexArticle(ports, id)).toBe("indexed");
    expect(await reindexArticle(ports, id)).toBe("unchanged");
    expect(unwrap(await search(ports, "Body")).articles).toHaveLength(1);
  });

  it("removes an article from the index once it is withdrawn", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations.\n");
    await reindexArticle(ports, id);
    unwrap(await unpublishArticle(ctx(), id));

    expect(await reindexArticle(ports, id)).toBe("removed");
    expect(unwrap(await search(ports, "invocations")).articles).toHaveLength(0);
  });

  it("never returns an article the index still holds but the database has withdrawn", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations.\n");
    await reindexArticle(ports, id);
    // The index lags by one event by design. Live state decides what a reader sees.
    unwrap(await unpublishArticle(ctx(), id));

    expect(unwrap(await search(ports, "invocations")).articles).toHaveLength(0);
  });

  it("indexes by title and by author, not only by body", async () => {
    const id = await publish("Measuring latency", "# Measuring latency\n\nUnrelated words.\n");
    await reindexArticle(ports, id);

    expect(unwrap(await search(ports, "latency")).articles).toHaveLength(1);
    expect(unwrap(await search(ports, "researcher")).articles).toHaveLength(1);
  });
});

describe("what gets indexed", () => {
  it("truncates a long body, because the index shares D1's ceiling (§31.3)", () => {
    const long = "word ".repeat(10_000);
    const truncated = truncateForIndex(long);
    expect(new TextEncoder().encode(truncated).length).toBeLessThanOrEqual(MAX_INDEXED_BODY_BYTES);
    expect(truncated.endsWith(" ")).toBe(false);
  });

  it("leaves a short body alone", () => {
    expect(truncateForIndex("a short article")).toBe("a short article");
  });

  it("strips invisible characters, so the index cannot answer a query nobody typed (§58.2)", () => {
    const smuggled = [..."secret"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(truncateForIndex(`visible${smuggled}`)).toBe("visible");
  });
});

describe("searching", () => {
  it("refuses an empty query rather than returning everything", async () => {
    const result = await search(ports, "   ");
    expect(!result.ok && result.error.type).toBe("validation-failed");
  });

  it("returns no cursor: a relevance ranking has no well-defined second page (§38)", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations.\n");
    await reindexArticle(ports, id);
    const found = unwrap(await search(ports, "invocations"));
    expect(found).not.toHaveProperty("next");
  });

  it("finds a principal by exact username, with or without the @", async () => {
    expect(unwrap(await searchPrincipals(ports, "researcher")).principals).toHaveLength(1);
    expect(unwrap(await searchPrincipals(ports, "@researcher")).principals).toHaveLength(1);
    expect(unwrap(await searchPrincipals(ports, "nobody")).principals).toHaveLength(0);
  });
});

/**
 * An id pasted into a search box (SPEC §13, §34.4).
 *
 * What somebody does with an id found in a citation, a log, or somebody else's article. §13
 * makes it the whole address, so it is answered as one rather than as a term — which also
 * means it resolves for an article the index has not reached yet.
 */
describe("searching by Article ID", () => {
  it("finds the article without the index having been told about it", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations.\n");

    // Deliberately not reindexed: §34.4 says a new article is readable at once and
    // searchable shortly after, and this path is the "at once" half.
    const found = unwrap(await search(ports, id));
    expect(found.articles.map((card) => card.id)).toEqual([id]);
  });

  it("forgives an id that arrived lowercased from a log or a shell", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations.\n");
    expect(unwrap(await search(ports, id.toLowerCase())).articles).toHaveLength(1);
  });

  it("echoes the query as it was typed", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations.\n");
    expect(unwrap(await search(ports, id.toLowerCase())).query).toBe(id.toLowerCase());
  });

  it("answers nothing for a well-formed id that names no published article", async () => {
    // Indistinguishable from any other query with no match, which is what keeps it from
    // being a yes/no oracle over somebody's unpublished work (§43.3).
    const draft = unwrap(await createArticle(ctx(), { title: "Draft", content: "# Draft\n\nx\n" }));
    expect(unwrap(await search(ports, draft.id)).articles).toHaveLength(0);
    // Twenty-six zeros: the right shape, and the leading 48 bits are the timestamp (§12.2),
    // so this one says 1970 and cannot have been minted.
    expect(unwrap(await search(ports, "0".repeat(26))).articles).toHaveLength(0);
  });

  it("does not mistake an ordinary word for an id", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations.\n");
    await reindexArticle(ports, id);
    // Still an FTS query: 26 characters of the right alphabet is the whole of the test, and
    // "invocations" is not that.
    expect(unwrap(await search(ports, "invocations")).articles).toHaveLength(1);
  });
});

describe("the feed (SPEC §37.1)", () => {
  it("returns published articles newest first", async () => {
    ports.setNow(new Date("2026-08-10T00:00:00.000Z"));
    await publish("First", "# First\n\nx\n");
    ports.setNow(new Date("2026-08-11T00:00:00.000Z"));
    await publish("Second", "# Second\n\ny\n");

    const page = await feed(ports);
    expect(page.cards.map((card) => card.title)).toEqual(["Second", "First"]);
  });

  it("does not depend on the search index at all", async () => {
    await publish("First", "# First\n\nx\n");
    // Nothing has been indexed; the feed is a read of the published index in D1 (§37.1).
    const page = await feed(ports);
    expect(page.cards).toHaveLength(1);
  });
});


describe("what a reindex compares", () => {
  it("rebuilds the entry when only the title changed", async () => {
    const body = "# Cold start\n\nA hundred invocations.\n";
    const id = await publish("Cold start", body);
    await reindexArticle(ports, id);

    // Same body, new title: the case that compared equal when the check was over the body
    // alone, leaving the previous title in the index. Live since Phase 4.
    const article = ports.state.articles.get(id);
    const current = ports.state.revisions.get(article!.publishedRevisionId!);
    ports.state.revisions.set(current!.id, { ...current!, title: "Warm start" });

    expect(await reindexArticle(ports, id)).toBe("indexed");
    expect(unwrap(await search(ports, "warm")).articles).toHaveLength(1);
  });

  it("still skips an event that changed nothing", async () => {
    const id = await publish("Cold start", "# Cold start\n\nA hundred invocations.\n");
    await reindexArticle(ports, id);
    expect(await reindexArticle(ports, id)).toBe("unchanged");
  });
});

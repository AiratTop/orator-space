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

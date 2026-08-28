import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, publishArticle } from "./publishing.js";
import { loadRelated, loadTopic, loadTopicTree, MAX_RELATED } from "./topics.js";

/**
 * Topic pages (SPEC §22, §22.1, §49.2, §38.2).
 *
 * The service had no test of its own: its two queries are covered against D1, which proves
 * the SQL and says nothing about the rules layered over it — that a section lists its
 * children's articles once each rather than once per child, that paging is keyset and
 * one-directional, and that "related" never offers a reader the article they are already
 * reading or a copy of it.
 *
 * That last one is the reason this file exists at a priority. §60.1 keeps duplicates
 * addressable, so a recommendation block that de-duplicates by id alone would offer the same
 * text twice under two titles.
 */

let ports: ReturnType<typeof createMemoryPorts>;

const AUTHOR = "AGENT-A";

const actor: Actor = {
  principalId: AUTHOR,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: "OWNER-H",
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

const seedTopic = (id: string, slug: string, parentSlug: string | null, status = "active") =>
  ports.state.topics.set(id, {
    id: id as never,
    slug,
    label: slug,
    description: `About ${slug}.`,
    parentSlug,
    status: status as "active",
  });

/** Publishes an article and files it under the given topics, the way the classifier would. */
async function publish(title: string, body: string, topicIds: string[]): Promise<string> {
  const draft = unwrap(await createArticle(ctx(), { title, content: body }));
  unwrap(await publishArticle(ctx(), draft.id));
  for (const topicId of topicIds) {
    const ids = ports.state.articleTopics.get(topicId) ?? new Set<string>();
    ids.add(draft.id);
    ports.state.articleTopics.set(topicId, ids);
  }
  return draft.id;
}

beforeEach(() => {
  ports = createMemoryPorts();
  ports.state.principals.set(AUTHOR, {
    id: AUTHOR as never,
    kind: "agent",
    username: "researcher",
    usernameSkeleton: "researcher",
    displayName: null,
    bio: null,
    status: "active",
    platformRole: "user",
    systemAccount: false,
    avatarMediaId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    ownerPrincipalId: "OWNER-H" as never,
    trustLevel: 1,
  });
  seedTopic("T-AI", "ai", null);
  seedTopic("T-LLM", "llm", "ai");
  seedTopic("T-AGENTS", "agents", "ai");
  seedTopic("T-OLD", "retired", "ai", "archived");
});

describe("the vocabulary as a tree (§22.1)", () => {
  it("offers sections with their leaves, and leaves out what is archived", async () => {
    const tree = await loadTopicTree(ports);

    expect(tree.map((branch) => branch.section.slug)).toEqual(["ai"]);
    // §22.1 — an archived topic keeps its page and leaves the vocabulary.
    expect(tree[0]?.children.map((child) => child.topic.slug)).toEqual(["llm", "agents"]);
  });

  it("counts an article in a section once, however many of its leaves it is in", async () => {
    // The join that gets this wrong reads as a section twice the size of its contents.
    await publish("Both", "# Both\n\nText.\n", ["T-LLM", "T-AGENTS"]);
    const tree = await loadTopicTree(ports);
    expect(tree[0]?.section.slug).toBe("ai");
    expect(tree[0]).toMatchObject({ articles: 1 });
  });
});

describe("one topic page (§22, §44.2)", () => {
  it("is not found rather than empty when the slug is not a topic", async () => {
    const result = await loadTopic(ports, "no-such-topic");
    expect(result.ok).toBe(false);
  });

  it("lists a leaf's articles, newest first", async () => {
    const first = await publish("First", "# First\n\nOne.\n", ["T-LLM"]);
    const second = await publish("Second", "# Second\n\nTwo.\n", ["T-LLM"]);

    const page = unwrap(await loadTopic(ports, "llm"));
    expect(page.cards.map((card) => card.id)).toEqual([second, first]);
    expect(page.children).toEqual([]);
    expect(page.next).toBeNull();
  });

  it("lists a section's children beneath it, and their articles once each", async () => {
    await publish("Both", "# Both\n\nText.\n", ["T-LLM", "T-AGENTS"]);

    const page = unwrap(await loadTopic(ports, "ai"));
    // Alphabetical, and without the archived one: §22.1 keeps its page and drops it here.
    expect(page.children.map((child) => child.slug)).toEqual(["agents", "llm"]);
    expect(page.cards).toHaveLength(1);
  });

  it("pages backwards only, and says so by carrying the cursor it was given", async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push(await publish(`A${n}`, `# A${n}\n\nText.\n`, ["T-LLM"]));

    const first = unwrap(await loadTopic(ports, "llm", { limit: 2 }));
    expect(first.cards).toHaveLength(2);
    expect(first.next).not.toBeNull();
    expect(first.previous).toBeNull();

    const second = unwrap(await loadTopic(ports, "llm", { limit: 2, before: first.next }));
    expect(second.cards.map((card) => card.id)).toEqual([ids[0]]);
    // Arriving through a cursor is itself the proof that something newer exists (§49.2).
    expect(second.previous).toEqual(first.next);
    expect(second.next).toBeNull();
  });
});

describe("articles like this one (§38.2, §60.1)", () => {
  it("says nothing at all when the article has no topics", async () => {
    const id = await publish("Alone", "# Alone\n\nText.\n", []);
    expect(await loadRelated(ports, id, [])).toEqual({ cards: [], because: null });
  });

  it("offers others in the same topic, and names the topic", async () => {
    const mine = await publish("Mine", "# Mine\n\nOne.\n", ["T-LLM"]);
    const theirs = await publish("Theirs", "# Theirs\n\nTwo.\n", ["T-LLM"]);

    const related = await loadRelated(ports, mine, [{ slug: "llm" }]);
    expect(related.cards.map((card) => card.id)).toEqual([theirs]);
    expect(related.because?.slug).toBe("llm");
  });

  it("never offers the article being read", async () => {
    const mine = await publish("Mine", "# Mine\n\nOne.\n", ["T-LLM"]);
    const related = await loadRelated(ports, mine, [{ slug: "llm" }]);
    expect(related.cards).toEqual([]);
  });

  it("never offers a second copy of the same body", async () => {
    // §60.1 keeps a duplicate addressable, so it is still a row this query can return.
    // Two suggestions with one body is the same recommendation twice.
    const body = "# Same\n\nExactly the same words.\n";
    const mine = await publish("Mine", "# Mine\n\nDifferent.\n", ["T-LLM"]);
    await publish("A copy", body, ["T-LLM"]);
    await publish("Another copy", body, ["T-LLM"]);

    const related = await loadRelated(ports, mine, [{ slug: "llm" }]);
    const hashes = related.cards.map((card) => card.contentHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("stops at three, however many share the topic", async () => {
    const mine = await publish("Mine", "# Mine\n\nOne.\n", ["T-LLM"]);
    for (const n of [1, 2, 3, 4, 5]) await publish(`Other ${n}`, `# O${n}\n\nText ${n}.\n`, ["T-LLM"]);

    const related = await loadRelated(ports, mine, [{ slug: "llm" }]);
    expect(related.cards).toHaveLength(MAX_RELATED);
  });
});

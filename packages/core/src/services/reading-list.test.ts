import { beforeEach, describe, expect, it } from "vitest";
import { ErrorType } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, publishArticle } from "./publishing.js";
import { isSaved, readingList, setSaved } from "./reading-list.js";

/**
 * SPEC §49.2, ADR 0011 — a private list, and the properties that keep it one.
 *
 * ADR 0011 refused a counter and named this exception. The tests worth writing are therefore
 * not "saving works" but the three things that would turn it back into what was refused: a
 * number somebody else can see, a route an agent can reach, and a record that outlives the
 * account.
 */
let ports: ReturnType<typeof createMemoryPorts>;

const actor: Actor = {
  principalId: "AGENT-A",
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

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

async function publish(title: string) {
  const created = unwrap(
    await createArticle(ctx(), { title, content: `A body about ${title}, long enough to store.` }),
  );
  await publishArticle(ctx(), created.id, {});
  return created.id;
}

beforeEach(() => {
  ports = createMemoryPorts();
  ports.state.principals.set("AGENT-A", {
    id: "AGENT-A",
    kind: "agent",
    username: "agent-a",
    usernameSkeleton: "agenta",
    displayName: null,
    bio: null,
    status: "active",
    platformRole: "user",
    systemAccount: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ownerPrincipalId: "OWNER-H",
    trustLevel: 1,
  } as never);
});

describe("saving an article", () => {
  it("is private to the reader who saved it", async () => {
    const id = await publish("Inference latency");
    await setSaved(ports, "READER-1", id, true);

    expect(await isSaved(ports, "READER-1", id)).toBe(true);
    // The whole of ADR 0011's objection, expressed as a test: nobody else can tell.
    expect(await isSaved(ports, "READER-2", id)).toBe(false);
    expect((await readingList(ports, "READER-2")).cards).toEqual([]);
  });

  it("is idempotent, because pressing a button twice meant it once", async () => {
    const id = await publish("Inference latency");
    await setSaved(ports, "READER-1", id, true);
    await setSaved(ports, "READER-1", id, true);

    expect((await readingList(ports, "READER-1")).cards).toHaveLength(1);
  });

  it("removes, and the list is a list rather than a log", async () => {
    const id = await publish("Inference latency");
    await setSaved(ports, "READER-1", id, true);
    await setSaved(ports, "READER-1", id, false);

    expect((await readingList(ports, "READER-1")).cards).toEqual([]);
    expect(await isSaved(ports, "READER-1", id)).toBe(false);
  });

  it("refuses an article that is not published, rather than answering the question", async () => {
    const draft = unwrap(await createArticle(ctx(), { title: "Draft", content: "Not published." }));
    const result = await setSaved(ports, "READER-1", draft.id, true);

    // §43.3 — "did the save succeed" must not become a yes/no oracle over somebody's drafts.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe(ErrorType.NotFound);
  });

  it("drops an article that has since been unpublished", async () => {
    const id = await publish("Inference latency");
    await setSaved(ports, "READER-1", id, true);
    ports.state.articles.set(id, { ...ports.state.articles.get(id)!, status: "unpublished" } as never);

    // The list shows what can still be read. Continuing to offer a tombstone would be the
    // platform holding somebody to a link that no longer answers.
    expect((await readingList(ports, "READER-1")).cards).toEqual([]);
  });
});

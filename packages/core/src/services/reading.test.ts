import { beforeEach, describe, expect, it } from "vitest";
import { decodeFeedCursor, encodeFeedCursor, negotiateRepresentation, representationPath } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { canonicalPath, resolveSlug } from "../articles/urls.js";
import { generateKeyPairForTesting, revisionSigningInput } from "../identity/keys.js";
import { AGENT_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, publishArticle, unpublishArticle } from "./publishing.js";
import {
  latestFeed,
  loadArticle,
  loadBody,
  loadProfile,
  pageSize,
  untrustedEnvelope,
  verifyProvenance,
} from "./reading.js";

let ports: ReturnType<typeof createMemoryPorts>;

const AUTHOR = "AGENT-A";
const OWNER = "OWNER-H";
const BODY = "# Cold start\n\nA hundred invocations per runtime, same payload.\n";

const actor: Actor = {
  principalId: AUTHOR,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: OWNER,
  status: "active",
};

const ctx = (): RequestContext => ({
  ports,
  requestId: "REQ",
  actor,
  tokenId: null,
  ipHash: null,
  userAgent: null,
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
  createdAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

/** Creates and publishes an article, returning its id. */
async function publish(title: string, body = BODY): Promise<string> {
  const draft = unwrap(await createArticle(ctx(), { title, content: body }));
  unwrap(await publishArticle(ctx(), draft.id));
  return draft.id;
}

beforeEach(() => {
  ports = createMemoryPorts();
  ports.state.principals.set(OWNER, principal(OWNER, "owner"));
  ports.state.principals.set(
    AUTHOR,
    principal(AUTHOR, "researcher", { kind: "agent", ownerPrincipalId: OWNER, model: "claude-opus-5", trustLevel: 1 }),
  );
});

describe("loading an article (SPEC §49)", () => {
  it("returns the published revision, its author and the ETag", async () => {
    const id = await publish("Cold start");
    const loaded = unwrap(await loadArticle(ports, id));

    expect(loaded.view.revision.title).toBe("Cold start");
    expect(loaded.view.author.username).toBe("researcher");
    // SPEC §33.2 — the ETag is the content hash, so revalidation needs no object read.
    expect(loaded.etag).toBe(loaded.view.revision.contentHash);
  });

  it("names the owner of an agent, so accountability is visible on the page (§7.2)", async () => {
    const id = await publish("Cold start");
    const loaded = unwrap(await loadArticle(ports, id));
    expect(loaded.view.author.ownerUsername).toBe("owner");
    expect(loaded.view.author.model).toBe("claude-opus-5");
  });

  it("does not read content storage — that is what makes a 304 cheap (§33.3)", async () => {
    const id = await publish("Cold start");
    let reads = 0;
    const counted = { ...ports, content: { ...ports.content, get: async (h: string) => (reads++, ports.content.get(h)) } };
    await loadArticle(counted, id);
    expect(reads).toBe(0);
  });

  it("reports a draft as absent rather than forbidden, so it is not an oracle (§43.3)", async () => {
    const draft = unwrap(await createArticle(ctx(), { title: "Unfinished", content: BODY }));
    const loaded = await loadArticle(ports, draft.id);
    expect(loaded.ok).toBe(false);
    expect(!loaded.ok && loaded.error.type).toBe("not-found");
  });

  it("stops serving an article the moment it is unpublished (§23.1)", async () => {
    const id = await publish("Cold start");
    expect((await loadArticle(ports, id)).ok).toBe(true);
    unwrap(await unpublishArticle(ctx(), id));
    expect((await loadArticle(ports, id)).ok).toBe(false);
  });

  it("stops serving the work of a suspended principal", async () => {
    const id = await publish("Cold start");
    ports.state.principals.set(AUTHOR, { ...ports.state.principals.get(AUTHOR)!, status: "suspended" });
    expect((await loadArticle(ports, id)).ok).toBe(false);
  });
});

describe("the body (§58.2)", () => {
  it("strips invisible characters on the way out, on every representation", async () => {
    const smuggled = `${BODY}\n\nvisible\u200B\u{E0041}\u{E0042}`;
    const id = await publish("Cold start", smuggled);
    const loaded = unwrap(await loadArticle(ports, id));
    const body = unwrap(await loadBody(ports, loaded.view));

    expect(body).toContain("visible");
    expect(body).not.toMatch(/[\u200B]|[\u{E0000}-\u{E007F}]/u);
    // The stored bytes are untouched: sanitisation is a read-time rule (§57.1).
    expect(await ports.content.get(loaded.view.revision.contentHash)).toContain("\u200B");
  });

  it("fails the request when the pointer resolves to nothing", async () => {
    const id = await publish("Cold start");
    const loaded = unwrap(await loadArticle(ports, id));
    await ports.content.delete(loaded.view.revision.contentHash);
    const body = await loadBody(ports, loaded.view);
    expect(!body.ok && body.error.type).toBe("unavailable");
  });
});

describe("provenance (§8.4)", () => {
  it("verifies a real signature", async () => {
    const id = await publish("Cold start");
    const article = ports.state.articles.get(id)!;
    const revision = ports.state.revisions.get(article.publishedRevisionId!)!;

    const pair = await generateKeyPairForTesting();
    const keyId = "KEY-1";
    ports.state.keys.set(keyId, {
      id: keyId as never,
      agentPrincipalId: AUTHOR as never,
      publicKey: pair.publicKey,
      fingerprint: "fp",
      label: null,
      status: "active",
      createdAt: "2026-08-01T00:00:00.000Z",
      revokedAt: null,
    });
    const signature = await pair.sign(
      revisionSigningInput({
        articleId: article.id,
        revisionId: revision.id,
        contentHash: revision.contentHash,
        createdAt: revision.createdAt,
      }),
    );
    ports.state.revisions.set(revision.id, { ...revision, signature, signatureKeyId: keyId as never });

    const loaded = unwrap(await loadArticle(ports, id));
    expect(await verifyProvenance(loaded.view)).toBe("verified");
  });

  it("distinguishes unsigned from invalid — they must never render as the same badge", async () => {
    const id = await publish("Cold start");
    const loaded = unwrap(await loadArticle(ports, id));
    expect(await verifyProvenance(loaded.view)).toBe("unsigned");

    const pair = await generateKeyPairForTesting();
    ports.state.keys.set("KEY-2", {
      id: "KEY-2" as never,
      agentPrincipalId: AUTHOR as never,
      publicKey: pair.publicKey,
      fingerprint: "fp2",
      label: null,
      status: "active",
      createdAt: "2026-08-01T00:00:00.000Z",
      revokedAt: null,
    });
    const revision = loaded.view.revision;
    ports.state.revisions.set(revision.id, {
      ...revision,
      signature: await pair.sign("something else entirely"),
      signatureKeyId: "KEY-2" as never,
    });

    const tampered = unwrap(await loadArticle(ports, id));
    expect(await verifyProvenance(tampered.view)).toBe("invalid");
  });

  it("reports a missing key as unavailable, not as a failed signature", async () => {
    const id = await publish("Cold start");
    const loaded = unwrap(await loadArticle(ports, id));
    ports.state.revisions.set(loaded.view.revision.id, {
      ...loaded.view.revision,
      signature: "AAAA",
      signatureKeyId: "GONE" as never,
    });
    const again = unwrap(await loadArticle(ports, id));
    expect(await verifyProvenance(again.view)).toBe("key-unavailable");
  });
});

describe("the untrusted envelope (§58.2)", () => {
  it("labels the body as data and names where it came from", async () => {
    const id = await publish("Cold start");
    const loaded = unwrap(await loadArticle(ports, id));
    const envelope = untrustedEnvelope(loaded.view, "body", "unsigned", "https://orator.space");

    expect(envelope.trust).toBe("untrusted");
    expect(envelope.source_principal).toBe("@researcher");
    expect(envelope.source_url).toBe(`https://orator.space/p/${id}/cold-start`);
    expect(envelope.signature_verified).toBe(false);
    expect(envelope.schema_version).toBe(1);
  });
});

describe("the latest feed (§37.1)", () => {
  it("orders by publication, newest first — not by id", async () => {
    // Created in one order, published in another. Ordering by id would return the wrong
    // sequence, and paginating by id would skip the article that was held back.
    const first = unwrap(await createArticle(ctx(), { title: "Written first", content: BODY }));
    const second = unwrap(await createArticle(ctx(), { title: "Written second", content: BODY }));

    ports.setNow(new Date("2026-08-10T00:00:00.000Z"));
    unwrap(await publishArticle(ctx(), second.id));
    ports.setNow(new Date("2026-08-11T00:00:00.000Z"));
    unwrap(await publishArticle(ctx(), first.id));

    const page = await latestFeed(ports);
    expect(page.cards.map((card) => card.title)).toEqual(["Written first", "Written second"]);
  });

  it("excludes drafts", async () => {
    await publish("Published");
    unwrap(await createArticle(ctx(), { title: "Draft", content: BODY }));
    const page = await latestFeed(ports);
    expect(page.cards).toHaveLength(1);
  });

  it("pages with a cursor and reports the end of the feed without a count", async () => {
    for (let i = 0; i < 5; i++) {
      ports.setNow(new Date(Date.UTC(2026, 7, 10 + i)));
      await publish(`Article ${i}`);
    }

    const first = await latestFeed(ports, { limit: 2 });
    expect(first.cards).toHaveLength(2);
    expect(first.next).not.toBeNull();

    const second = await latestFeed(ports, { limit: 2, before: first.next });
    const third = await latestFeed(ports, { limit: 2, before: second.next });

    const titles = [...first.cards, ...second.cards, ...third.cards].map((c) => c.title);
    expect(titles).toEqual(["Article 4", "Article 3", "Article 2", "Article 1", "Article 0"]);
    expect(third.next).toBeNull();
  });

  it("caps the page size so a client cannot ask for the whole table", () => {
    expect(pageSize(1000)).toBe(50);
    expect(pageSize(null)).toBe(20);
    expect(pageSize(0)).toBe(20);
    expect(pageSize(7)).toBe(7);
  });
});

describe("profiles (§49.2)", () => {
  it("resolves a principal by username and lists their published work", async () => {
    await publish("Cold start");
    const profile = unwrap(await loadProfile(ports, "researcher"));
    expect(profile.principal.kind).toBe("agent");
    expect(profile.page.cards).toHaveLength(1);
  });

  it("reports an unknown username as absent", async () => {
    expect((await loadProfile(ports, "nobody")).ok).toBe(false);
  });
});

describe("slugs (§13)", () => {
  it("serves the canonical path unchanged", () => {
    expect(resolveSlug({ id: "A", slug: "cold-start" }, "cold-start")).toEqual({ kind: "serve" });
  });

  it("redirects a stale slug to the current one instead of 404ing", () => {
    expect(resolveSlug({ id: "A", slug: "cold-start" }, "whatever-it-used-to-be")).toEqual({
      kind: "redirect",
      to: "/p/A/cold-start",
    });
  });

  it("redirects the bare id to the slugged path", () => {
    expect(resolveSlug({ id: "A", slug: "cold-start" }, null)).toEqual({ kind: "redirect", to: "/p/A/cold-start" });
  });

  it("serves the bare id when the article has no slug", () => {
    expect(resolveSlug({ id: "A", slug: null }, null)).toEqual({ kind: "serve" });
    expect(canonicalPath({ id: "A", slug: null })).toBe("/p/A");
  });
});

describe("content negotiation (§33.5, §48)", () => {
  it("gives a browser HTML even though its Accept header also asks for JSON", () => {
    const browser = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
    expect(negotiateRepresentation(browser)).toBe("html");
  });

  it("recognises the machine formats", () => {
    expect(negotiateRepresentation("text/markdown")).toBe("markdown");
    expect(negotiateRepresentation("application/json")).toBe("json");
    expect(negotiateRepresentation("application/ld+json")).toBe("json");
  });

  it("falls back to HTML for an absent or unusable header", () => {
    expect(negotiateRepresentation(null)).toBe("html");
    expect(negotiateRepresentation("*/*")).toBe("html");
    expect(negotiateRepresentation("application/pdf")).toBe("html");
  });

  it("puts each variant at its own URL, without the slug", () => {
    expect(representationPath("/p/ABC/cold-start", "markdown")).toBe("/p/ABC.md");
    expect(representationPath("/p/ABC/cold-start", "json")).toBe("/p/ABC.json");
    expect(representationPath("/p/ABC/cold-start", "html")).toBe("/p/ABC/cold-start");
  });
});

describe("feed cursors (§12.2)", () => {
  it("round-trips", () => {
    const cursor = { publishedAt: "2026-08-11T00:00:00.000Z", id: "01K3EXAMPLE" };
    expect(decodeFeedCursor(encodeFeedCursor(cursor))).toEqual(cursor);
  });

  it("treats a malformed cursor as the first page rather than an error", () => {
    expect(decodeFeedCursor("!!!not base64!!!")).toBeNull();
    expect(decodeFeedCursor("")).toBeNull();
    expect(decodeFeedCursor(null)).toBeNull();
  });
});

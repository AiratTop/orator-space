import { beforeEach, describe, expect, it } from "vitest";
import { ErrorType } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { generateKeyPairForTesting, revisionSigningInput } from "../identity/keys.js";
import { AGENT_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, createRevision, publishArticle, unpublishArticle } from "./publishing.js";
import { withIdempotency } from "./idempotency.js";

let ports: ReturnType<typeof createMemoryPorts>;

const AUTHOR = "AGENT-A";
const OWNER = "OWNER-H";

const agentActor = (overrides: Partial<Actor> = {}): Actor => ({
  principalId: AUTHOR,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: OWNER,
  status: "active",
  trustLevel: 1,
  ...overrides,
});

const ctxFor = (actor: Actor | null): RequestContext => ({
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
const errorOf = (r: { ok: boolean; error?: { type: string } }) => {
  if (r.ok) throw new Error("expected failure");
  return r.error!.type;
};

const BODY = "# Measuring cold start\n\nA hundred invocations per runtime, same payload.\n";

beforeEach(() => {
  ports = createMemoryPorts();
  // Author and owner exist so authorisation has something to resolve.
  ports.state.principals.set(OWNER, {
    id: OWNER as never,
    kind: "human",
    username: "owner",
    usernameSkeleton: "owner",
    displayName: null,
    bio: null,
    status: "active",
    platformRole: "user",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  ports.state.principals.set(AUTHOR, {
    id: AUTHOR as never,
    kind: "agent",
    username: "researcher",
    usernameSkeleton: "researcher",
    displayName: null,
    bio: null,
    status: "active",
    platformRole: "user",
    createdAt: "2026-08-01T00:00:00.000Z",
    ownerPrincipalId: OWNER as never,
  });
});

describe("creating an article (SPEC §16)", () => {
  it("writes the body to content storage and the metadata to the database", async () => {
    const article = unwrap(await createArticle(ctxFor(agentActor()), { title: "Cold start", content: BODY }));
    expect(await ports.content.get(article.contentHash)).toBe(BODY);
    expect(ports.state.revisions.get(article.revisionId)?.contentRef).toContain(article.contentHash);
  });

  it("starts as a draft and emits nothing — a draft is not activity", async () => {
    await createArticle(ctxFor(agentActor()), { title: "Cold start", content: BODY });
    expect([...ports.state.articles.values()][0]?.status).toBe("draft");
    expect(ports.state.events).toHaveLength(0);
    expect(ports.state.outbox).toHaveLength(0);
  });

  it("derives a slug but keeps identity in the id", async () => {
    const article = unwrap(
      await createArticle(ctxFor(agentActor()), { title: "Measuring Cold Start", content: BODY }),
    );
    expect(article.slug).toBe("measuring-cold-start");
    expect(article.url).toBe(`/p/${article.id}/measuring-cold-start`);
  });

  it("forces ai_generated when the author is an agent, whatever was requested", async () => {
    // A self-declared provenance field would be worthless exactly where it matters (§10).
    const article = unwrap(
      await createArticle(ctxFor(agentActor()), {
        title: "Cold start",
        content: BODY,
        authorshipDisclosure: "human_authored",
      }),
    );
    expect(ports.state.articles.get(article.id)?.authorshipDisclosure).toBe("ai_generated");
  });

  it("refuses without the write scope", async () => {
    const readOnly = ctxFor(agentActor({ scopes: ["articles:read"] }));
    expect(errorOf(await createArticle(readOnly, { title: "x", content: BODY }))).toBe(
      ErrorType.InsufficientScope,
    );
  });

  it("refuses invalid content before touching storage", async () => {
    const ctx = ctxFor(agentActor());
    expect(errorOf(await createArticle(ctx, { title: "", content: BODY }))).toBe(ErrorType.ValidationFailed);
    expect(ports.state.articles.size).toBe(0);
  });
});

describe("revisions and concurrency (SPEC §34.3)", () => {
  async function seedArticle() {
    return unwrap(await createArticle(ctxFor(agentActor()), { title: "Cold start", content: BODY }));
  }

  it("creates a new revision and moves the pointer", async () => {
    const article = await seedArticle();
    const revision = unwrap(
      await createRevision(ctxFor(agentActor()), article.id, { title: "Cold start", content: BODY + "\nMore.\n" }),
    );
    expect(revision.unchanged).toBe(false);
    expect(ports.state.articles.get(article.id)?.currentRevisionId).toBe(revision.id);
    expect(ports.state.revisions.get(revision.id)?.parentRevisionId).toBe(article.revisionId);
  });

  it("does not create a revision for identical content", async () => {
    // A retrying agent would otherwise accumulate thousands of rows saying nothing (§16.4).
    const article = await seedArticle();
    const again = unwrap(
      await createRevision(ctxFor(agentActor()), article.id, { title: "Cold start", content: BODY }),
    );
    expect(again.unchanged).toBe(true);
    expect(again.id).toBe(article.revisionId);
    expect(ports.state.revisions.size).toBe(1);
  });

  it("rejects a stale If-Match", async () => {
    const article = await seedArticle();
    const result = await createRevision(ctxFor(agentActor()), article.id, {
      title: "Cold start",
      content: BODY + "\nEdit.\n",
      ifMatch: "06G20000000000000000000000",
    });
    expect(errorOf(result)).toBe(ErrorType.PreconditionFailed);
    expect((result as { error: { extra?: Record<string, unknown> } }).error.extra?.current_revision_id).toBe(
      article.revisionId,
    );
  });

  it("accepts a current If-Match", async () => {
    const article = await seedArticle();
    const result = await createRevision(ctxFor(agentActor()), article.id, {
      title: "Cold start",
      content: BODY + "\nEdit.\n",
      ifMatch: article.revisionId,
    });
    expect(result.ok).toBe(true);
  });

  it("keeps every revision — history is immutable", async () => {
    const article = await seedArticle();
    await createRevision(ctxFor(agentActor()), article.id, { title: "v2", content: BODY + "2" });
    await createRevision(ctxFor(agentActor()), article.id, { title: "v3", content: BODY + "3" });
    expect(ports.state.revisions.size).toBe(3);
  });

  it("refuses a sibling agent under the same owner", async () => {
    const article = await seedArticle();
    const sibling = ctxFor(agentActor({ principalId: "AGENT-B" }));
    const result = await createRevision(sibling, article.id, { title: "x", content: BODY + "!" });
    expect(errorOf(result)).toBe(ErrorType.Forbidden);
  });
});

describe("publishing (SPEC §16.3, §35)", () => {
  async function seedArticle() {
    return unwrap(await createArticle(ctxFor(agentActor()), { title: "Cold start", content: BODY }));
  }

  it("moves the pointer rather than copying content", async () => {
    const article = await seedArticle();
    const published = unwrap(await publishArticle(ctxFor(agentActor()), article.id));
    const record = ports.state.articles.get(article.id);
    expect(record?.status).toBe("published");
    expect(record?.publishedRevisionId).toBe(published.revisionId);
    expect(ports.state.revisions.size).toBe(1);
  });

  it("writes the outbox row in the same transaction as the publish", async () => {
    // The whole asynchronous pipeline depends on this being atomic (§35.1).
    const article = await seedArticle();
    await publishArticle(ctxFor(agentActor()), article.id);
    expect(ports.state.outbox.map((e) => e.eventType)).toEqual(["article.published"]);
    expect(ports.state.outbox[0]?.requestId).toBe("REQ");
  });

  it("emits a public activity event", async () => {
    const article = await seedArticle();
    await publishArticle(ctxFor(agentActor()), article.id);
    expect(ports.state.events[0]?.type).toBe("article.published");
    expect(ports.state.events[0]?.visibility).toBe("public");
  });

  it("separates writing from publishing", async () => {
    const article = await seedArticle();
    const drafter = ctxFor(agentActor({ scopes: ["articles:read", "articles:write"] }));
    expect(errorOf(await publishArticle(drafter, article.id))).toBe(ErrorType.InsufficientScope);
  });

  it("lets a published article continue to be revised without changing what readers see", async () => {
    const article = await seedArticle();
    await publishArticle(ctxFor(agentActor()), article.id);
    const draft = unwrap(
      await createRevision(ctxFor(agentActor()), article.id, { title: "Cold start", content: BODY + "\nDraft.\n" }),
    );
    const record = ports.state.articles.get(article.id);
    expect(record?.currentRevisionId).toBe(draft.id);
    // Still serving the published revision — the point of the two pointers (§16.3).
    expect(record?.publishedRevisionId).toBe(article.revisionId);
  });

  it("unpublishes reversibly, keeping the published pointer", async () => {
    const article = await seedArticle();
    await publishArticle(ctxFor(agentActor()), article.id);
    await unpublishArticle(ctxFor(agentActor()), article.id);
    const record = ports.state.articles.get(article.id);
    expect(record?.status).toBe("unpublished");
    expect(record?.publishedRevisionId).not.toBeNull();
  });
});

/**
 * SPEC §15.1 — import is a standing mode, not a migration.
 *
 * The platform's first content comes from outside, and an article may live both here and on
 * the author's own site. Everything import needs goes through the ordinary write path, so
 * these are the rules that keep an imported article from lying about itself.
 */
describe("import and cross-posting (SPEC §15.1)", () => {
  const seed = async (input = {}) =>
    unwrap(await createArticle(ctxFor(agentActor()), { title: "An older post", content: BODY, ...input }));

  it("records the primary publication's address at creation, not by a later patch", async () => {
    // A two-call sequence leaves a window in which the copy is indexable and competing
    // with the original, which is the outcome §50.2 warns about.
    const article = await seed({ canonicalUrl: "https://example.com/older-post" });
    expect(ports.state.articles.get(article.id)?.canonicalUrl).toBe("https://example.com/older-post");
  });

  it("publishes with the original date rather than today's", async () => {
    const article = await seed();
    const published = unwrap(
      await publishArticle(ctxFor(agentActor()), article.id, { publishedAt: "2024-03-11T09:00:00.000Z" }),
    );

    expect(published.publishedAt).toBe("2024-03-11T09:00:00.000Z");
    expect(ports.state.articles.get(article.id)?.publishedAt).toBe("2024-03-11T09:00:00.000Z");
  });

  it("dates the event now, whatever date the article carries", async () => {
    // An event stamped 2024 would sort into the wrong place in a journal read by cursor
    // (§20.5), and the outbox would deliver a notification that appears to predate itself.
    const article = await seed();
    await publishArticle(ctxFor(agentActor()), article.id, { publishedAt: "2024-03-11T09:00:00.000Z" });

    expect(ports.state.events[0]?.createdAt).not.toBe("2024-03-11T09:00:00.000Z");
    expect(ports.state.outbox[0]?.createdAt).not.toBe("2024-03-11T09:00:00.000Z");
  });

  it("refuses a date in the future", async () => {
    const article = await seed();
    const result = await publishArticle(ctxFor(agentActor()), article.id, {
      publishedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(errorOf(result)).toBe(ErrorType.ValidationFailed);
  });

  it("refuses to restamp an article that already has a date", async () => {
    // Refused rather than ignored: §16.3 fills the column once, so accepting the field and
    // discarding it would be a silent no-op on the one field an importer cares about.
    const article = await seed();
    unwrap(await publishArticle(ctxFor(agentActor()), article.id));
    const again = await publishArticle(ctxFor(agentActor()), article.id, {
      publishedAt: "2024-03-11T09:00:00.000Z",
    });
    expect(errorOf(again)).toBe(ErrorType.Conflict);
  });

  it("keeps the first date when a corrected revision is published later", async () => {
    const article = await seed();
    unwrap(await publishArticle(ctxFor(agentActor()), article.id, { publishedAt: "2024-03-11T09:00:00.000Z" }));
    const revision = unwrap(
      await createRevision(ctxFor(agentActor()), article.id, { title: "An older post", content: BODY + "\nFixed.\n" }),
    );
    unwrap(await publishArticle(ctxFor(agentActor()), article.id, { revisionId: revision.id }));

    expect(ports.state.articles.get(article.id)?.publishedAt).toBe("2024-03-11T09:00:00.000Z");
  });

  it("judges the signing key at signing time, not at the date the article claims", async () => {
    // The import happens now. A key registered today is valid today, and checking it
    // against 2024 would refuse every signed import (§8.4).
    const key = await generateKeyPairForTesting();
    ports.state.keys.set("KEY-IMPORT", {
      id: "KEY-IMPORT" as never,
      agentPrincipalId: AUTHOR as never,
      publicKey: key.publicKey,
      fingerprint: "fp-import",
      label: null,
      status: "active",
      createdAt: "2026-08-01T00:00:00.000Z",
      revokedAt: null,
    });

    const article = await seed();
    const revision = ports.state.revisions.get(article.revisionId)!;
    const signature = await key.sign(
      revisionSigningInput({
        articleId: article.id,
        revisionId: revision.id,
        contentHash: revision.contentHash,
        createdAt: revision.createdAt,
      }),
    );

    const published = unwrap(
      await publishArticle(ctxFor(agentActor()), article.id, {
        signature,
        signatureKeyId: "KEY-IMPORT",
        publishedAt: "2024-03-11T09:00:00.000Z",
      }),
    );
    expect(published.signed).toBe(true);
    expect(published.publishedAt).toBe("2024-03-11T09:00:00.000Z");
  });
});

describe("revision signatures (SPEC §8.4)", () => {
  async function seedSignable() {
    const article = unwrap(await createArticle(ctxFor(agentActor()), { title: "Cold start", content: BODY }));
    const revision = ports.state.revisions.get(article.revisionId)!;
    const key = await generateKeyPairForTesting();
    const keyId = "KEY-1";
    ports.state.keys.set(keyId, {
      id: keyId as never,
      agentPrincipalId: AUTHOR as never,
      publicKey: key.publicKey,
      fingerprint: "fp",
      label: null,
      status: "active",
      createdAt: "2026-08-01T00:00:00.000Z",
      revokedAt: null,
    });
    const message = revisionSigningInput({
      articleId: article.id,
      revisionId: revision.id,
      contentHash: revision.contentHash,
      createdAt: revision.createdAt,
    });
    return { article, key, keyId, message };
  }

  it("attaches a valid signature at publish time", async () => {
    const { article, key, keyId, message } = await seedSignable();
    const published = unwrap(
      await publishArticle(ctxFor(agentActor()), article.id, {
        signature: await key.sign(message),
        signatureKeyId: keyId,
      }),
    );
    expect(published.signed).toBe(true);
    expect(ports.state.revisions.get(article.revisionId)?.signature).not.toBeNull();
  });

  it("refuses a signature from a key belonging to someone else", async () => {
    const { article, keyId, message } = await seedSignable();
    const outsider = await generateKeyPairForTesting();
    ports.state.keys.set(keyId, { ...ports.state.keys.get(keyId)!, agentPrincipalId: "AGENT-B" as never });
    const result = await publishArticle(ctxFor(agentActor()), article.id, {
      signature: await outsider.sign(message),
      signatureKeyId: keyId,
    });
    expect(errorOf(result)).toBe(ErrorType.ValidationFailed);
  });

  it("refuses a signature over different content", async () => {
    const { article, key, keyId } = await seedSignable();
    const wrong = revisionSigningInput({
      articleId: article.id,
      revisionId: article.revisionId,
      contentHash: "tampered",
      createdAt: "2026-08-21T12:00:00.000Z",
    });
    const result = await publishArticle(ctxFor(agentActor()), article.id, {
      signature: await key.sign(wrong),
      signatureKeyId: keyId,
    });
    expect(errorOf(result)).toBe(ErrorType.ValidationFailed);
  });

  it("publishes unsigned when no signature is supplied, and says so", async () => {
    const { article } = await seedSignable();
    expect(unwrap(await publishArticle(ctxFor(agentActor()), article.id)).signed).toBe(false);
  });
});

describe("idempotency (SPEC §34.1)", () => {
  const body = { title: "Cold start", content: BODY };

  it("returns the first result for a repeated key, without doing the work twice", async () => {
    const ctx = ctxFor(agentActor());
    const run = () => withIdempotency(ctx, "KEY-1", "POST /v1/articles", body, () => createArticle(ctx, body));
    const first = unwrap(await run());
    const second = unwrap(await run());
    expect(second.id).toBe(first.id);
    expect(ports.state.articles.size).toBe(1);
  });

  it("refuses the same key with a different body", async () => {
    const ctx = ctxFor(agentActor());
    await withIdempotency(ctx, "KEY-2", "POST /v1/articles", body, () => createArticle(ctx, body));
    const result = await withIdempotency(ctx, "KEY-2", "POST /v1/articles", { ...body, title: "Other" }, () =>
      createArticle(ctx, { ...body, title: "Other" }),
    );
    expect(errorOf(result)).toBe(ErrorType.IdempotencyKeyReuse);
  });

  it("scopes keys to the principal, so two agents can use the same key", async () => {
    const a = ctxFor(agentActor());
    const b = ctxFor(agentActor({ principalId: "AGENT-B" }));
    ports.state.principals.set("AGENT-B", { ...ports.state.principals.get(AUTHOR)!, id: "AGENT-B" as never });
    await withIdempotency(a, "SHARED", "POST /v1/articles", body, () => createArticle(a, body));
    const second = await withIdempotency(b, "SHARED", "POST /v1/articles", body, () => createArticle(b, body));
    expect(second.ok).toBe(true);
    expect(ports.state.articles.size).toBe(2);
  });

  it("frees the key after a transient failure so a retry can proceed", async () => {
    const ctx = ctxFor(agentActor());
    const failed = await withIdempotency(ctx, "KEY-3", "POST /v1/articles", body, async () => ({
      ok: false as const,
      error: { type: ErrorType.Unavailable, title: "Storage unavailable" },
    }));
    expect(failed.ok).toBe(false);
    const retry = await withIdempotency(ctx, "KEY-3", "POST /v1/articles", body, () => createArticle(ctx, body));
    expect(retry.ok).toBe(true);
  });

  it("replays a permanent failure as the same failure, not as success", async () => {
    const ctx = ctxFor(agentActor());
    const bad = { title: "", content: BODY };
    const first = await withIdempotency(ctx, "KEY-4", "POST /v1/articles", bad, () => createArticle(ctx, bad));
    expect(errorOf(first)).toBe(ErrorType.ValidationFailed);

    const replay = await withIdempotency(ctx, "KEY-4", "POST /v1/articles", bad, () => {
      throw new Error("the operation must not run a second time");
    });
    expect(errorOf(replay)).toBe(ErrorType.ValidationFailed);
  });
});

describe("signing a revision written before the key existed (regression)", () => {
  it("accepts a key registered after the revision", async () => {
    // Caught end to end: the check compared the key against the revision's creation time,
    // so the ordinary sequence — draft, then register a key, then sign and publish — was
    // refused. What matters is whether the key is usable when it signs.
    const article = unwrap(await createArticle(ctxFor(agentActor()), { title: "Cold start", content: BODY }));
    const revision = ports.state.revisions.get(article.revisionId)!;
    const key = await generateKeyPairForTesting();
    ports.state.keys.set("KEY-LATE", {
      id: "KEY-LATE" as never,
      agentPrincipalId: AUTHOR as never,
      publicKey: key.publicKey,
      fingerprint: "fp-late",
      label: null,
      status: "active",
      // Registered a day after the revision was written.
      createdAt: "2026-08-22T12:00:00.000Z",
      revokedAt: null,
    });
    ports.setNow(new Date("2026-08-23T12:00:00.000Z"));

    const signature = await key.sign(
      revisionSigningInput({
        articleId: article.id,
        revisionId: revision.id,
        contentHash: revision.contentHash,
        createdAt: revision.createdAt,
      }),
    );
    const published = unwrap(
      await publishArticle(ctxFor(agentActor()), article.id, { signature, signatureKeyId: "KEY-LATE" }),
    );
    expect(published.signed).toBe(true);
  });

  it("still refuses a key that has been revoked", async () => {
    const article = unwrap(await createArticle(ctxFor(agentActor()), { title: "Cold start", content: BODY }));
    const revision = ports.state.revisions.get(article.revisionId)!;
    const key = await generateKeyPairForTesting();
    ports.state.keys.set("KEY-DEAD", {
      id: "KEY-DEAD" as never,
      agentPrincipalId: AUTHOR as never,
      publicKey: key.publicKey,
      fingerprint: "fp-dead",
      label: null,
      status: "revoked",
      createdAt: "2026-08-01T00:00:00.000Z",
      revokedAt: "2026-08-10T00:00:00.000Z",
    });
    const signature = await key.sign(
      revisionSigningInput({
        articleId: article.id,
        revisionId: revision.id,
        contentHash: revision.contentHash,
        createdAt: revision.createdAt,
      }),
    );
    expect(
      errorOf(await publishArticle(ctxFor(agentActor()), article.id, { signature, signatureKeyId: "KEY-DEAD" })),
    ).toBe(ErrorType.ValidationFailed);
  });
});

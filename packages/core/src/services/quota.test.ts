import { beforeEach, describe, expect, it } from "vitest";
import { ErrorType } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET, OWNER_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, publishArticle, createRevision } from "./publishing.js";
import { createComment, createEdge, follow } from "./social.js";
import { registerAgent } from "./identity.js";
import { createMedia } from "./media.js";

/**
 * SPEC §59.2 — the quota, where it is actually enforced.
 *
 * The limits are checked in `identity/quota.test.ts` and the counter in the edge app. What
 * is checked here is that the write path consults them at all, and consults them at the
 * right moment: after authorisation, before the row, and against the right principal.
 */

let ports: ReturnType<typeof createMemoryPorts>;

const AGENT = "AGENT-A";
const OWNER = "OWNER-H";
const BODY = "# Cold start\n\nA hundred invocations per runtime.\n";

const actor = (overrides: Partial<Actor> = {}): Actor => ({
  principalId: AGENT,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: OWNER,
  status: "active",
  trustLevel: 1,
  systemAccount: false,
  ...overrides,
});

const owner = (): Actor => ({
  principalId: OWNER,
  kind: "human",
  platformRole: "user",
  scopes: OWNER_PRESET,
  status: "active",
  trustLevel: 1,
  systemAccount: false,
});

const ctxFor = (who: Actor): RequestContext => ({
  ports,
  requestId: "REQ",
  actor: who,
  tokenId: null,
  ipHash: null,
  userAgent: null,
  audience: "agent_api",
});

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

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};

const errorOf = (r: { ok: boolean; error?: { type: string } }): string | null =>
  r.ok ? null : (r.error?.type ?? "unknown");

beforeEach(() => {
  ports = createMemoryPorts();
  ports.state.principals.set(OWNER, principal(OWNER, "owner"));
  ports.state.principals.set(
    AGENT,
    principal(AGENT, "researcher", { kind: "agent", ownerPrincipalId: OWNER, model: "claude-opus-5", trustLevel: 1 }),
  );
});

describe("publishing (§59.2)", () => {
  /** Creates and publishes one article, returning whether it was allowed. */
  async function publishOne(n: number): Promise<string | null> {
    const draft = await createArticle(ctxFor(actor()), { title: `Article ${n}`, content: `${BODY}${n}` });
    if (!draft.ok) return errorOf(draft);
    return errorOf(await publishArticle(ctxFor(actor()), draft.value.id));
  }

  it("allows twenty publications a day and refuses the twenty-first", async () => {
    for (let i = 0; i < 20; i += 1) expect(await publishOne(i), `article ${i}`).toBeNull();
    expect(await publishOne(20)).toBe(ErrorType.QuotaExceeded);
  });

  it("carries the allowance and the reset time in the refusal", async () => {
    for (let i = 0; i < 20; i += 1) await publishOne(i);
    const draft = unwrap(await createArticle(ctxFor(actor()), { title: "One more", content: `${BODY}x` }));
    const refused = await publishArticle(ctxFor(actor()), draft.id);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    // §59.2 requires the quota structure, §45.1 requires Retry-After, and the reset time is
    // the one an agent can plan against — a duration is stale the moment it is read.
    const quota = (refused.error.extra as { quota: { limit: number; remaining: number; resetAt: string } }).quota;
    expect(quota.limit).toBe(20);
    expect(quota.remaining).toBe(0);
    expect(Date.parse(quota.resetAt)).toBeGreaterThan(ports.clock.now().getTime());
    expect(refused.error.retryAfter).toBeGreaterThan(0);
  });

  it("does not charge for republishing a corrected revision (§16.4)", async () => {
    const draft = unwrap(await createArticle(ctxFor(actor()), { title: "Measured", content: BODY }));
    unwrap(await publishArticle(ctxFor(actor()), draft.id));

    for (let i = 0; i < 25; i += 1) {
      const revision = unwrap(
        await createRevision(ctxFor(actor()), draft.id, { title: "Measured", content: `${BODY}${i}` }),
      );
      // An author must not have to choose between fixing a mistake and publishing
      // something new; the limit is on articles, not on edits.
      expect(
        errorOf(await publishArticle(ctxFor(actor()), draft.id, { revisionId: revision.id })),
        `revision ${i}`,
      ).toBeNull();
    }
  });

  it("charges the author, not whoever pressed publish", async () => {
    // §43.2 lets an owner publish for an agent they own. If the limit followed the caller,
    // one owner with ten agents would have ten times the allowance of one agent — §60.3's
    // sybil argument reproduced inside a single account.
    const draft = unwrap(await createArticle(ctxFor(actor()), { title: "By the agent", content: BODY }));
    unwrap(await publishArticle(ctxFor(owner()), draft.id));

    const spent = await ports.quota.peek(AGENT, 1);
    expect(spent.find((entry) => entry.action === "articles.publish")?.remaining).toBe(19);
    const ownersOwn = await ports.quota.peek(OWNER, 1);
    expect(ownersOwn.find((entry) => entry.action === "articles.publish")?.remaining).toBe(20);
  });

  it("refuses a draft past the draft limit, before writing anything", async () => {
    for (let i = 0; i < 100; i += 1) {
      unwrap(await createArticle(ctxFor(actor()), { title: `Draft ${i}`, content: `${BODY}${i}` }));
    }
    const refused = await createArticle(ctxFor(actor()), { title: "One too many", content: `${BODY}x` });

    expect(errorOf(refused)).toBe(ErrorType.QuotaExceeded);
    expect(ports.state.articles.size).toBe(100);
  });
});

describe("the rest of the write path", () => {
  async function publishedArticle(): Promise<string> {
    const draft = unwrap(await createArticle(ctxFor(actor()), { title: "Subject", content: BODY }));
    unwrap(await publishArticle(ctxFor(actor()), draft.id));
    return draft.id;
  }

  it("caps comments at sixty an hour", async () => {
    const articleId = await publishedArticle();
    const critic = actor({ principalId: "AGENT-B", ownerPrincipalId: OWNER });
    ports.state.principals.set(
      "AGENT-B",
      principal("AGENT-B", "critic", { kind: "agent", ownerPrincipalId: OWNER }),
    );

    for (let i = 0; i < 60; i += 1) {
      expect(errorOf(await createComment(ctxFor(critic), articleId, { content: `note ${i}` })), `${i}`).toBeNull();
    }
    expect(errorOf(await createComment(ctxFor(critic), articleId, { content: "one more" }))).toBe(
      ErrorType.QuotaExceeded,
    );
  });

  it("caps edges at a hundred a day", async () => {
    const source = await publishedArticle();
    const target = await publishedArticle();
    // A hundred are allowed; the hundred-and-first is not.
    for (let i = 0; i < 100; i += 1) {
      // Same pair each time would collide on the unique index, so the kind varies.
      const kinds = ["cites", "supports", "extends", "references", "summarizes"] as const;
      await createEdge(ctxFor(actor()), {
        srcArticleId: source,
        kind: kinds[i % kinds.length]!,
        dstUri: `https://example.org/${i}`,
      });
    }
    const refused = await createEdge(ctxFor(actor()), {
      srcArticleId: source,
      kind: "cites",
      dstArticleId: target,
    });
    expect(errorOf(refused)).toBe(ErrorType.QuotaExceeded);
  });

  it("does not charge a follow the caller already holds", async () => {
    ports.state.principals.set("AGENT-C", principal("AGENT-C", "other", { kind: "agent", ownerPrincipalId: OWNER }));
    unwrap(await follow(ctxFor(actor()), "AGENT-C"));
    unwrap(await follow(ctxFor(actor()), "AGENT-C"));
    unwrap(await follow(ctxFor(actor()), "AGENT-C"));

    const spent = await ports.quota.peek(AGENT, 1);
    expect(spent.find((entry) => entry.action === "follows")?.remaining).toBe(199);
  });

  it("caps agent creation against the owner (§60.3)", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect(errorOf(await registerAgent(ctxFor(owner()), { username: `agent-${i}` })), `${i}`).toBeNull();
    }
    expect(errorOf(await registerAgent(ctxFor(owner()), { username: "one-too-many" }))).toBe(
      ErrorType.QuotaExceeded,
    );
  });

  it("caps media records, not only uploaded bytes", async () => {
    for (let i = 0; i < 200; i += 1) {
      expect(errorOf(await createMedia(ctxFor(actor()), { kind: "image" })), `${i}`).toBeNull();
    }
    // §21.1 makes the upload a second call. A caller creating records and never uploading
    // still costs rows the retention cron has to clean up (§23.4).
    expect(errorOf(await createMedia(ctxFor(actor()), { kind: "image" }))).toBe(ErrorType.QuotaExceeded);
  });
});

describe("when the counter cannot be reached (§59.1, §61)", () => {
  /** A gate that always fails, as an unreachable Durable Object does. */
  const broken = () => ({
    ...ports,
    quota: {
      consume: async (_id: string, action: string, trust: number) =>
        (await import("../identity/quota.js")).unmetered(action as never, trust, ports.clock.now()),
      peek: async (_id: string, trust: number) =>
        Promise.all(
          (await import("../identity/quota.js")).QUOTA_ACTIONS.map(async (action) =>
            (await import("../identity/quota.js")).unmetered(action, trust, ports.clock.now()),
          ),
        ),
    },
  });

  it("publishes anyway, rather than refusing every write", async () => {
    // §61 settles this for an unavailable moderation provider — publish and mark unchecked,
    // do not block — and a counter is the same shape of dependency. A quota that failed
    // closed would turn one Durable Object hiccup into a platform accepting no writes.
    const ctx = { ...ctxFor(actor()), ports: broken() } as RequestContext;
    const draft = await createArticle(ctx, { title: "While the counter is away", content: BODY });

    expect(draft.ok).toBe(true);
  });

  it("marks the call unmetered rather than reporting a full allowance", async () => {
    const ctx = { ...ctxFor(actor()), ports: broken() } as RequestContext;
    unwrap(await createArticle(ctx, { title: "Unmetered", content: BODY }));

    const entries = await ctx.ports.quota.peek(AGENT, 1);
    // A `remaining` figure invented to look like an answer is a lie an agent plans
    // against. `metered: false` is the honest state: nothing is known.
    expect(entries.every((entry) => entry.metered === false)).toBe(true);
  });
});

describe("trust levels (§60.2)", () => {
  it("gives a level-0 principal a quarter of the allowance", async () => {
    const fresh = actor({ trustLevel: 0 });
    for (let i = 0; i < 5; i += 1) {
      const draft = await createArticle(ctxFor(fresh), { title: `A ${i}`, content: `${BODY}${i}` });
      if (!draft.ok) continue;
      await publishArticle(ctxFor(fresh), draft.value.id);
    }
    const spent = await ports.quota.peek(AGENT, 0);
    const publish = spent.find((entry) => entry.action === "articles.publish");
    expect(publish?.limit).toBe(5);
    expect(publish?.remaining).toBe(0);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET, OWNER_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, publishArticle } from "./publishing.js";
import {
  createComment,
  createEdge,
  deleteComment,
  deleteEdge,
  follow,
  MAX_COMMENT_DEPTH,
  replyToComment,
  unfollow,
} from "./social.js";

let ports: ReturnType<typeof createMemoryPorts>;

const AUTHOR = "AGENT-A";
const CRITIC = "AGENT-B";
const OWNER = "OWNER-H";
const OTHER_OWNER = "OWNER-2";
const BODY = "# Cold start\n\nA hundred invocations per runtime.\n";

const actorFor = (principalId: string, owner: string, overrides: Partial<Actor> = {}): Actor => ({
  principalId,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: owner,
  status: "active",
  trustLevel: 1,
  systemAccount: false,
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

/** Publishes an article by `AUTHOR` and returns its id. */
async function publishedArticle(title = "Cold start"): Promise<string> {
  const draft = unwrap(await createArticle(ctxFor(actorFor(AUTHOR, OWNER)), { title, content: BODY }));
  unwrap(await publishArticle(ctxFor(actorFor(AUTHOR, OWNER)), draft.id));
  return draft.id;
}

const notificationsFor = (principalId: string) =>
  ports.state.events.filter((event) => event.audiencePrincipalId === principalId);

beforeEach(() => {
  ports = createMemoryPorts();
  ports.state.principals.set(OWNER, principal(OWNER, "owner"));
  ports.state.principals.set(OTHER_OWNER, principal(OTHER_OWNER, "other-owner"));
  ports.state.principals.set(AUTHOR, principal(AUTHOR, "researcher", { kind: "agent", ownerPrincipalId: OWNER }));
  ports.state.principals.set(CRITIC, principal(CRITIC, "critic", { kind: "agent", ownerPrincipalId: OTHER_OWNER }));
});

describe("commenting (SPEC §17)", () => {
  it("records the comment and notifies the article's author", async () => {
    const articleId = await publishedArticle();
    const comment = unwrap(
      await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, {
        content: "The baseline is wrong.",
        stance: "challenges",
      }),
    );

    expect(ports.state.comments.get(comment.id)?.contentMarkdown).toBe("The baseline is wrong.");
    // §20.1 — this is the mechanism the network's success criterion depends on.
    const notified = notificationsFor(AUTHOR);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.type).toBe("comment.created");
    expect(notified[0]?.visibility).toBe("private");
  });

  it("also records public activity, which is a different row for a different reader (§20.3)", async () => {
    const articleId = await publishedArticle();
    await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, { content: "Interesting." });

    const publicRows = ports.state.events.filter((e) => e.visibility === "public" && e.type === "comment.created");
    expect(publicRows).toHaveLength(1);
    expect(publicRows[0]?.audiencePrincipalId).toBeNull();
  });

  it("does not notify an author who commented on their own article", async () => {
    const articleId = await publishedArticle();
    await createComment(ctxFor(actorFor(AUTHOR, OWNER)), articleId, { content: "A clarification." });
    expect(notificationsFor(AUTHOR)).toHaveLength(0);
  });

  it("writes the comment and the notification in one commit (§35.1)", async () => {
    const articleId = await publishedArticle();
    const before = ports.state.events.length;
    await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, { content: "x" });
    // A comment that exists without its event would leave the author permanently unaware.
    expect(ports.state.comments.size).toBe(1);
    expect(ports.state.events.length).toBeGreaterThan(before);
  });

  it("strips invisible characters, which a comment has no reason to carry (§58.2)", async () => {
    const articleId = await publishedArticle();
    const comment = unwrap(
      await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, {
        content: "Looks fine\u200B\u{E0041}\u{E0042}",
      }),
    );
    expect(ports.state.comments.get(comment.id)?.contentMarkdown).toBe("Looks fine");
  });

  it("refuses an empty comment and one that is only invisible characters", async () => {
    const articleId = await publishedArticle();
    const ctx = ctxFor(actorFor(CRITIC, OTHER_OWNER));
    expect(errorOf(await createComment(ctx, articleId, { content: "   " }))).toBe("validation-failed");
    expect(errorOf(await createComment(ctx, articleId, { content: "\u200B\u200B" }))).toBe("validation-failed");
  });

  it("refuses a comment over the size cap", async () => {
    const articleId = await publishedArticle();
    const result = await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, {
      content: "x".repeat(9000),
    });
    expect(errorOf(result)).toBe("validation-failed");
  });

  it("refuses to comment on a draft, and says not-found rather than forbidden", async () => {
    const draft = unwrap(await createArticle(ctxFor(actorFor(AUTHOR, OWNER)), { title: "Draft", content: BODY }));
    const result = await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), draft.id, { content: "x" });
    expect(errorOf(result)).toBe("not-found");
  });

  it("requires authentication and the comments:write scope", async () => {
    const articleId = await publishedArticle();
    expect(errorOf(await createComment(ctxFor(null), articleId, { content: "x" }))).toBe("unauthenticated");

    const readOnly = actorFor(CRITIC, OTHER_OWNER, { scopes: ["articles:read"] });
    expect(errorOf(await createComment(ctxFor(readOnly), articleId, { content: "x" }))).toBe("insufficient-scope");
  });
});

describe("threads (SPEC §17)", () => {
  it("notifies the parent's author on a reply, not the article's author", async () => {
    const articleId = await publishedArticle();
    const comment = unwrap(
      await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, { content: "The baseline is wrong." }),
    );

    unwrap(await replyToComment(ctxFor(actorFor(AUTHOR, OWNER)), comment.id, { content: "Here is why it is not." }));

    const toCritic = notificationsFor(CRITIC);
    expect(toCritic).toHaveLength(1);
    expect(toCritic[0]?.type).toBe("comment.replied");
  });

  it("keeps the whole thread under one root, so fetching it is one indexed read", async () => {
    const articleId = await publishedArticle();
    const first = unwrap(await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, { content: "a" }));
    const second = unwrap(await replyToComment(ctxFor(actorFor(AUTHOR, OWNER)), first.id, { content: "b" }));
    const third = unwrap(await replyToComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), second.id, { content: "c" }));

    expect(second.rootCommentId).toBe(first.id);
    expect(third.rootCommentId).toBe(first.id);
    expect(third.depth).toBe(2);
  });

  it("refuses to nest past the depth limit, and says what to do instead", async () => {
    const articleId = await publishedArticle();
    let parent = unwrap(await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, { content: "0" }));
    for (let depth = 1; depth <= MAX_COMMENT_DEPTH; depth++) {
      parent = unwrap(await replyToComment(ctxFor(actorFor(AUTHOR, OWNER)), parent.id, { content: String(depth) }));
    }
    const tooDeep = await replyToComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), parent.id, { content: "over" });
    expect(errorOf(tooDeep)).toBe("validation-failed");
    expect(!tooDeep.ok && tooDeep.error.detail).toContain("Reply higher in the thread");
  });
});

describe("removing a comment (SPEC §23.2)", () => {
  it("keeps the row so the thread keeps its shape", async () => {
    const articleId = await publishedArticle();
    const comment = unwrap(await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, { content: "a" }));
    unwrap(await replyToComment(ctxFor(actorFor(AUTHOR, OWNER)), comment.id, { content: "b" }));

    unwrap(await deleteComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), comment.id));

    expect(ports.state.comments.get(comment.id)?.status).toBe("removed");
    expect(ports.state.comments.size).toBe(2);
  });

  it("lets the accountable owner remove their agent's comment", async () => {
    const articleId = await publishedArticle();
    const comment = unwrap(await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, { content: "a" }));
    const owner: Actor = {
      principalId: OTHER_OWNER,
      kind: "human",
      platformRole: "user",
      scopes: OWNER_PRESET,
      status: "active",
      trustLevel: 1,
      systemAccount: false,
    };
    expect((await deleteComment(ctxFor(owner), comment.id)).ok).toBe(true);
  });

  it("refuses a stranger, and is idempotent for the author", async () => {
    const articleId = await publishedArticle();
    const comment = unwrap(await createComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), articleId, { content: "a" }));

    expect(errorOf(await deleteComment(ctxFor(actorFor(AUTHOR, OWNER)), comment.id))).toBe("forbidden");
    expect((await deleteComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), comment.id)).ok).toBe(true);
    expect((await deleteComment(ctxFor(actorFor(CRITIC, OTHER_OWNER)), comment.id)).ok).toBe(true);
  });
});

describe("edges (SPEC §18)", () => {
  it("lets an author link their own article to another, and notifies the target", async () => {
    const target = await publishedArticle("Original");
    const source = unwrap(
      await createArticle(ctxFor(actorFor(CRITIC, OTHER_OWNER)), { title: "Response", content: BODY }),
    );

    const edge = unwrap(
      await createEdge(ctxFor(actorFor(CRITIC, OTHER_OWNER)), {
        srcArticleId: source.id,
        kind: "challenges",
        dstArticleId: target,
      }),
    );

    expect(edge.kind).toBe("challenges");
    const notified = notificationsFor(AUTHOR);
    expect(notified.map((event) => event.type)).toContain("article.challenged");
  });

  it("refuses an edge asserted about someone else's article", async () => {
    const target = await publishedArticle("Original");
    const stranger = unwrap(
      await createArticle(ctxFor(actorFor(CRITIC, OTHER_OWNER)), { title: "Mine", content: BODY }),
    );

    // AUTHOR trying to claim that CRITIC's article cites theirs.
    const result = await createEdge(ctxFor(actorFor(AUTHOR, OWNER)), {
      srcArticleId: stranger.id,
      kind: "cites",
      dstArticleId: target,
    });
    expect(errorOf(result)).toBe("forbidden");
  });

  it("requires exactly one target", async () => {
    const source = unwrap(await createArticle(ctxFor(actorFor(AUTHOR, OWNER)), { title: "S", content: BODY }));
    const ctx = ctxFor(actorFor(AUTHOR, OWNER));

    expect(errorOf(await createEdge(ctx, { srcArticleId: source.id, kind: "cites" }))).toBe("validation-failed");
    expect(
      errorOf(
        await createEdge(ctx, {
          srcArticleId: source.id,
          kind: "cites",
          dstArticleId: source.id,
          dstUri: "https://example.test",
        }),
      ),
    ).toBe("validation-failed");
  });

  it("accepts an external target", async () => {
    const source = unwrap(await createArticle(ctxFor(actorFor(AUTHOR, OWNER)), { title: "S", content: BODY }));
    const edge = unwrap(
      await createEdge(ctxFor(actorFor(AUTHOR, OWNER)), {
        srcArticleId: source.id,
        kind: "references",
        dstUri: "https://example.test/paper",
      }),
    );
    expect(edge.dstUri).toBe("https://example.test/paper");
    expect(edge.dstArticleId).toBeNull();
  });

  it("refuses a self-link", async () => {
    const source = unwrap(await createArticle(ctxFor(actorFor(AUTHOR, OWNER)), { title: "S", content: BODY }));
    const result = await createEdge(ctxFor(actorFor(AUTHOR, OWNER)), {
      srcArticleId: source.id,
      kind: "cites",
      dstArticleId: source.id,
    });
    expect(errorOf(result)).toBe("validation-failed");
  });

  it("reports a repeated assertion as a conflict rather than a crash", async () => {
    const target = await publishedArticle("Original");
    const source = unwrap(
      await createArticle(ctxFor(actorFor(CRITIC, OTHER_OWNER)), { title: "Response", content: BODY }),
    );
    const ctx = ctxFor(actorFor(CRITIC, OTHER_OWNER));
    const input = { srcArticleId: source.id, kind: "cites" as const, dstArticleId: target };

    unwrap(await createEdge(ctx, input));
    expect(errorOf(await createEdge(ctx, input))).toBe("conflict");
  });

  it("withdraws an edge, and only for its own author", async () => {
    const target = await publishedArticle("Original");
    const source = unwrap(
      await createArticle(ctxFor(actorFor(CRITIC, OTHER_OWNER)), { title: "Response", content: BODY }),
    );
    const edge = unwrap(
      await createEdge(ctxFor(actorFor(CRITIC, OTHER_OWNER)), {
        srcArticleId: source.id,
        kind: "cites",
        dstArticleId: target,
      }),
    );

    expect(errorOf(await deleteEdge(ctxFor(actorFor(AUTHOR, OWNER)), edge.id))).toBe("forbidden");
    unwrap(await deleteEdge(ctxFor(actorFor(CRITIC, OTHER_OWNER)), edge.id));
    expect(ports.state.edges.size).toBe(0);
  });
});

describe("follows (SPEC §19)", () => {
  it("records a follow and notifies the followee", async () => {
    unwrap(await follow(ctxFor(actorFor(CRITIC, OTHER_OWNER)), AUTHOR));
    expect(await ports.social.isFollowing(CRITIC, AUTHOR)).toBe(true);
    expect(notificationsFor(AUTHOR).map((e) => e.type)).toContain("principal.followed");
  });

  it("is idempotent, because following twice is the same state and not an error", async () => {
    unwrap(await follow(ctxFor(actorFor(CRITIC, OTHER_OWNER)), AUTHOR));
    unwrap(await follow(ctxFor(actorFor(CRITIC, OTHER_OWNER)), AUTHOR));
    expect(notificationsFor(AUTHOR)).toHaveLength(1);
  });

  it("refuses to follow itself or an unknown principal", async () => {
    const ctx = ctxFor(actorFor(CRITIC, OTHER_OWNER));
    expect(errorOf(await follow(ctx, CRITIC))).toBe("validation-failed");
    expect(errorOf(await follow(ctx, "NOBODY"))).toBe("not-found");
  });

  it("unfollows, and unfollowing what was never followed is not an error", async () => {
    const ctx = ctxFor(actorFor(CRITIC, OTHER_OWNER));
    unwrap(await unfollow(ctx, AUTHOR));
    unwrap(await follow(ctx, AUTHOR));
    unwrap(await unfollow(ctx, AUTHOR));
    expect(await ports.social.isFollowing(CRITIC, AUTHOR)).toBe(false);
  });
});

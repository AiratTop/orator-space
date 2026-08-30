import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET, OWNER_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, createRevision, publishArticle } from "./publishing.js";
import { eraseArticle, removeArticle, updateArticle } from "./lifecycle.js";
import { createReport } from "./moderation.js";

let ports: ReturnType<typeof createMemoryPorts>;

const AUTHOR = "AGENT-A";
const OWNER = "OWNER-H";
const STRANGER = "OWNER-2";
const BODY = "# Cold start\n\nA hundred invocations per runtime.\n";

const agent: Actor = {
  principalId: AUTHOR,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: OWNER,
  status: "active",
  trustLevel: 1,
  systemAccount: false,
};

const owner: Actor = {
  principalId: OWNER,
  kind: "human",
  platformRole: "user",
  scopes: OWNER_PRESET,
  status: "active",
  trustLevel: 1,
  systemAccount: false,
};

const stranger: Actor = { ...owner, principalId: STRANGER };

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

async function published(content = BODY): Promise<string> {
  const draft = unwrap(await createArticle(ctxFor(agent), { title: "Cold start", content }));
  unwrap(await publishArticle(ctxFor(agent), draft.id));
  return draft.id;
}

beforeEach(() => {
  ports = createMemoryPorts();
  ports.state.principals.set(OWNER, principal(OWNER, "owner"));
  ports.state.principals.set(STRANGER, principal(STRANGER, "stranger"));
  ports.state.principals.set(AUTHOR, principal(AUTHOR, "researcher", { kind: "agent", ownerPrincipalId: OWNER }));
});

describe("updating metadata (SPEC §44.2)", () => {
  it("changes only the fields present", async () => {
    const id = await published();
    unwrap(await updateArticle(ctxFor(agent), id, { visibility: "unlisted" }));

    const article = ports.state.articles.get(id)!;
    expect(article.visibility).toBe("unlisted");
    expect(article.language).toBe("en");
  });

  it("treats an explicit null as a clear, not as an absent field", async () => {
    const id = await published();
    unwrap(await updateArticle(ctxFor(agent), id, { canonicalUrl: null }));
    expect(ports.state.articles.get(id)!.canonicalUrl).toBeNull();
  });

  it("refuses to let an agent relabel its output as human-authored (§10)", async () => {
    const id = await published();
    const result = await updateArticle(ctxFor(agent), id, { authorshipDisclosure: "human_authored" });
    expect(errorOf(result)).toBe("validation-failed");
  });

  it("emits an event, because visibility changes what the derived data should hold", async () => {
    const id = await published();
    const before = ports.state.outbox.length;
    unwrap(await updateArticle(ctxFor(agent), id, { visibility: "private" }));
    expect(ports.state.outbox.slice(before).map((e) => e.eventType)).toContain("article.updated");
  });

  it("writes nothing when there is nothing to change", async () => {
    const id = await published();
    const before = ports.state.outbox.length;
    unwrap(await updateArticle(ctxFor(agent), id, {}));
    expect(ports.state.outbox.length).toBe(before);
  });

  it("refuses a stranger", async () => {
    const id = await published();
    expect(errorOf(await updateArticle(ctxFor(stranger), id, { visibility: "private" }))).toBe("forbidden");
  });
});

describe("removing an article (SPEC §23.2)", () => {
  it("leaves a tombstone rather than deleting the row", async () => {
    const id = await published();
    unwrap(await removeArticle(ctxFor(agent), id));

    const article = ports.state.articles.get(id)!;
    expect(article.status).toBe("removed");
    // The id survives forever and is never reused, so citations keep resolving.
    expect(ports.state.articles.has(id)).toBe(true);
  });

  it("keeps the content, which is what distinguishes it from erasure", async () => {
    const id = await published();
    const revisionId = ports.state.articles.get(id)!.publishedRevisionId!;
    const hash = ports.state.revisions.get(revisionId)!.contentHash;

    unwrap(await removeArticle(ctxFor(agent), id));
    expect(await ports.content.get(hash)).toBe(BODY);
  });

  it("is idempotent", async () => {
    const id = await published();
    const first = unwrap(await removeArticle(ctxFor(agent), id));
    const second = unwrap(await removeArticle(ctxFor(agent), id));
    expect(second.removedAt).toBe(first.removedAt);
  });

  it("refuses a token without articles:delete", async () => {
    const id = await published();
    const limited: Actor = { ...agent, scopes: ["articles:write", "articles:publish"] };
    expect(errorOf(await removeArticle(ctxFor(limited), id))).toBe("insufficient-scope");
  });
});

describe("erasing an article (SPEC §23.3)", () => {
  it("destroys the bytes and keeps the trace", async () => {
    const id = await published();
    const revisionId = ports.state.articles.get(id)!.publishedRevisionId!;
    const hash = ports.state.revisions.get(revisionId)!.contentHash;

    const outcome = unwrap(await eraseArticle(ctxFor(owner), id, { confirm: "erase" }));

    expect(outcome.contentDeleted).toBe(true);
    expect(await ports.content.get(hash)).toBeNull();

    const revision = ports.state.revisions.get(revisionId)!;
    expect(revision.contentRef).toBe("");
    expect(revision.title).toBe("[erased]");
    // The hash stays: it proves what was erased without being it.
    expect(revision.contentHash).toBe(hash);
  });

  it("records who did it and when", async () => {
    const id = await published();
    unwrap(await eraseArticle(ctxFor(owner), id, { confirm: "erase", reason: "subject request" }));

    const entry = ports.state.audit.find((row) => row.action === "article.erased");
    expect(entry?.actorPrincipalId).toBe(OWNER);
    expect(entry?.reason).toBe("subject request");
  });

  it("does NOT delete a body another article still references (§23.3 step 3)", async () => {
    // Two articles by different authors with byte-identical content — which content
    // addressing makes one object. Deleting it would destroy the other author's article.
    const mine = await published();
    const theirsDraft = unwrap(
      await createArticle(ctxFor({ ...stranger, kind: "human" }), { title: "Same words", content: BODY }),
    );
    const hash = ports.state.revisions.get(ports.state.articles.get(mine)!.publishedRevisionId!)!.contentHash;

    const outcome = unwrap(await eraseArticle(ctxFor(owner), mine, { confirm: "erase" }));

    expect(outcome.contentDeleted).toBe(false);
    expect(await ports.content.get(hash)).toBe(BODY);
    // And the other article is untouched.
    expect(ports.state.revisions.get(ports.state.articles.get(theirsDraft.id)!.currentRevisionId!)!.contentRef).not.toBe("");
  });

  it("escalates that case rather than passing over it silently (§23.3 step 4)", async () => {
    const mine = await published();
    unwrap(await createArticle(ctxFor({ ...stranger, kind: "human" }), { title: "Same words", content: BODY }));

    const outcome = unwrap(await eraseArticle(ctxFor(owner), mine, { confirm: "erase" }));
    expect(outcome.escalated).toBe(true);
  });

  it("erases every revision, not only the published one", async () => {
    const id = await published();
    unwrap(
      await createRevision(ctxFor(agent), id, {
        title: "Cold start",
        content: "# Cold start\n\nA revised body.\n",
        ifMatch: null,
      }),
    );

    const outcome = unwrap(await eraseArticle(ctxFor(owner), id, { confirm: "erase" }));
    expect(outcome.revisions).toBe(2);
    for (const revision of ports.state.revisions.values()) {
      expect(revision.contentRef).toBe("");
    }
  });

  /**
   * §23.3 covers the history, not a page of it.
   *
   * The erase used to read two hundred revisions and blank those. An article with more kept
   * the older ones — text, title and `content_ref` intact — and the call answered success
   * with `revisions: 200`. Worse than the leak itself: those surviving rows counted as
   * outside references, so step 3 declined to delete the R2 object too, and the one
   * operation that exists to satisfy a legal demand quietly satisfied none of it.
   *
   * 250 rather than 201, so this keeps failing if somebody raises a page size to 200-odd
   * instead of removing the page.
   */
  it("erases a history longer than any page of it (§23.3)", async () => {
    const id = await published();
    for (let n = 0; n < 249; n += 1) {
      unwrap(
        await createRevision(ctxFor(agent), id, {
          title: `Revision ${n}`,
          content: `# Revision ${n}\n\nA body that differs each time.\n`,
          ifMatch: null,
        }),
      );
    }

    const outcome = unwrap(await eraseArticle(ctxFor(owner), id, { confirm: "erase" }));

    expect(outcome.revisions).toBe(250);
    const mine = [...ports.state.revisions.values()].filter((revision) => revision.articleId === id);
    expect(mine).toHaveLength(250);
    for (const revision of mine) {
      expect(revision.contentRef, revision.id).toBe("");
      expect(revision.title, revision.id).toBe("[erased]");
    }

    // And every body is gone from the store, not only the newest page of them.
    for (const revision of mine) {
      expect(await ports.content.get(revision.contentHash), revision.contentHash).toBeNull();
    }
    expect(outcome.escalated).toBe(false);
  });

  /**
   * The second erasure of the same bytes finishes the job the first could not (§23.3).
   *
   * Two articles, identical text, therefore one object. Erasing the first correctly declines
   * to delete it and escalates. Erasing the second used to decline as well — the reference
   * count included the first article's blanked revisions, whose `content_hash` §23.3 keeps
   * as the trace — so both articles were erased, nothing referenced the object any more, and
   * it stayed in the store for good with no error anywhere.
   */
  it("deletes the shared body once the last live reference is erased (§23.3)", async () => {
    const mine = await published();
    const theirs = unwrap(
      await createArticle(ctxFor({ ...stranger, kind: "human" }), { title: "Same words", content: BODY }),
    );
    const hash = ports.state.revisions.get(ports.state.articles.get(mine)!.publishedRevisionId!)!.contentHash;

    const first = unwrap(await eraseArticle(ctxFor(owner), mine, { confirm: "erase" }));
    expect(first.contentDeleted).toBe(false);
    expect(first.escalated).toBe(true);
    expect(await ports.content.get(hash)).toBe(BODY);

    const second = unwrap(
      await eraseArticle(ctxFor({ ...stranger, kind: "human" }), theirs.id, { confirm: "erase" }),
    );

    expect(second.escalated).toBe(false);
    expect(second.contentDeleted).toBe(true);
    expect(await ports.content.get(hash)).toBeNull();
  });

  it("refuses a new revision on an article that has been erased", async () => {
    // The other half of the race below, and the one the domain closes outright: erasure sets
    // `removed` in the same batch that blanks the revisions, so nothing can be added to the
    // article afterwards and no new reference to its bodies can appear through it.
    const id = await published();
    unwrap(await eraseArticle(ctxFor(owner), id, { confirm: "erase" }));

    const result = await createRevision(ctxFor(agent), id, {
      title: "After the fact",
      content: "# After the fact\n\nA body.\n",
      ifMatch: null,
    });
    expect(errorOf(result)).toBe("not-found");
  });

  /**
   * A publisher of the same bytes arriving mid-erasure keeps their body (§23.3, §16.2).
   *
   * The reference check that chooses what to delete runs before the commit; the delete runs
   * after it. Content is addressed by hash, so in that window somebody else publishing
   * byte-identical text acquires a live reference to the very object about to be destroyed —
   * and would be left with an article pointing at bytes that are not there.
   *
   * Simulated by publishing from inside the commit, which is the window itself rather than an
   * approximation of it.
   */
  it("does not delete a body that gained a reference while the erasure ran", async () => {
    const mine = await published();
    const hash = ports.state.revisions.get(ports.state.articles.get(mine)!.publishedRevisionId!)!.contentHash;

    const commit = ports.db.commit.bind(ports.db);
    let raced = false;
    ports.db.commit = async (writes) => {
      const result = await commit(writes);
      if (!raced) {
        raced = true;
        // Someone publishes the same text, one instant after the pointers were blanked.
        unwrap(await createArticle(ctxFor({ ...stranger, kind: "human" }), { title: "Same words", content: BODY }));
      }
      return result;
    };

    const outcome = unwrap(await eraseArticle(ctxFor(owner), mine, { confirm: "erase" }));

    expect(outcome.raced).toBe(1);
    expect(outcome.contentDeleted).toBe(false);
    // The other author's article still has its body.
    expect(await ports.content.get(hash)).toBe(BODY);
  });

  it("requires the confirmation verbatim", async () => {
    const id = await published();
    expect(errorOf(await eraseArticle(ctxFor(owner), id, { confirm: "yes" }))).toBe("validation-failed");
    expect(errorOf(await eraseArticle(ctxFor(owner), id, { confirm: "" }))).toBe("validation-failed");
  });

  it("refuses an agent, however well scoped: destroying evidence is the owner's act", async () => {
    const id = await published();
    const result = await eraseArticle(ctxFor(agent), id, { confirm: "erase" });
    expect(errorOf(result)).toBe("forbidden");
    // And nothing was destroyed on the way to refusing.
    const revisionId = ports.state.articles.get(id)!.publishedRevisionId!;
    expect(ports.state.revisions.get(revisionId)!.contentRef).not.toBe("");
  });

  it("refuses a stranger", async () => {
    const id = await published();
    expect(errorOf(await eraseArticle(ctxFor(stranger), id, { confirm: "erase" }))).toBe("forbidden");
  });
});

describe("reporting content (SPEC §61)", () => {
  it("accepts a report from someone with no account at all (§61.2)", async () => {
    const id = await published();
    const report = unwrap(
      await createReport(ctxFor(null), { targetType: "article", targetId: id, category: "illegal" }),
    );
    expect(report.status).toBe("open");
    expect(ports.state.reports[0]?.reporterPrincipalId).toBeNull();
  });

  // `stranger`, not `owner`: §7.2 makes the author the accountable party for their own
  // article, and a report from them is refused. What this test is about is where a signed-in
  // reporter is recorded, so any signed-in reporter who is not the author will do.
  it("records who reported in the audit log, not in the public activity feed (§20.3)", async () => {
    const id = await published();
    unwrap(await createReport(ctxFor(stranger), { targetType: "article", targetId: id, category: "spam" }));

    expect(ports.state.audit.some((row) => row.action === "report.created")).toBe(true);
    expect(ports.state.events.some((row) => row.type === "report.created")).toBe(false);
  });

  it("refuses a report about something that does not exist", async () => {
    const result = await createReport(ctxFor(null), {
      targetType: "article",
      targetId: "NOTHING",
      category: "spam",
    });
    expect(errorOf(result)).toBe("not-found");
  });

  it("stops one target being used to fill the table from outside", async () => {
    const id = await published();
    for (let i = 0; i < 20; i++) {
      unwrap(await createReport(ctxFor(null), { targetType: "article", targetId: id, category: "spam" }));
    }
    const result = await createReport(ctxFor(null), { targetType: "article", targetId: id, category: "spam" });
    expect(errorOf(result)).toBe("rate-limited");
  });
});

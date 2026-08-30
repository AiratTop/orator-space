import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { RETENTION_BATCH, RETENTION_HOURS, runRetention } from "./retention.js";

/**
 * SPEC §23.4 — every table with a bounded retention has a handler that enforces it.
 *
 * The sentence after the table is the reason: a table with no cleanup handler is a future
 * incident. Not usually a bill — a database that grows until §31.3's limit stops writes, or
 * a column of hashed addresses that outlives every purpose it was collected for and becomes
 * a liability on the day somebody asks what is in it.
 */

let ports: ReturnType<typeof createMemoryPorts>;

const NOW = new Date("2026-08-22T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

beforeEach(() => {
  ports = createMemoryPorts();
  ports.setNow(NOW);
});

const outboxRow = (id: string, createdAt: string) => ({
  id: id as never,
  eventType: "article.published",
  aggregateType: "article",
  aggregateId: "A1" as never,
  payload: { schema_version: 1 },
  requestId: "REQ",
  createdAt,
});

const auditRow = (id: string, createdAt: string) => ({
  id: id as never,
  actorPrincipalId: "P1" as never,
  actorTokenId: "T1",
  action: "token.issued",
  targetType: "principal",
  targetId: "P1",
  outcome: "success" as const,
  reason: null,
  ipHash: "abc123",
  userAgent: "curl/8",
  requestId: "REQ",
  createdAt,
});

describe("the outbox (§23.4, seven days)", () => {
  it("removes delivered rows past the window and keeps the rest", async () => {
    await ports.db.commit([
      ports.outbox.enqueue(outboxRow("OLD-SENT", hoursAgo(RETENTION_HOURS.outbox + 1))),
      ports.outbox.enqueue(outboxRow("NEW-SENT", hoursAgo(1))),
      ports.outbox.enqueue(outboxRow("OLD-PENDING", hoursAgo(RETENTION_HOURS.outbox + 1))),
    ]);
    await ports.db.commit([ports.outbox.markSent(["OLD-SENT", "NEW-SENT"], NOW.toISOString())]);

    const report = await runRetention(ports);

    expect(report.outboxDeleted).toBe(1);
    // An undelivered row is the pipeline, not a backlog: deleting it would lose the event
    // the transaction was written to guarantee (§35.1).
    expect(ports.state.outbox.map((entry) => entry.id).sort()).toEqual(["NEW-SENT", "OLD-PENDING"]);
  });
});

describe("idempotency keys (§23.4, twenty-four hours)", () => {
  it("removes a key older than the window", async () => {
    const claim = (key: string, createdAt: string) =>
      ports.idempotency.claim({
        key,
        principalId: "P1",
        endpoint: "POST /v1/articles",
        requestHash: "h",
        createdAt,
      });
    await ports.db.commit([claim("old", hoursAgo(25)), claim("fresh", hoursAgo(1))]);

    const report = await runRetention(ports);

    expect(report.idempotencyDeleted).toBe(1);
    // §34.1 — a key older than a day guards a request that is long over.
    expect(await ports.idempotency.find("P1", "old")).toBeNull();
    expect(await ports.idempotency.find("P1", "fresh")).not.toBeNull();
  });
});

describe("the audit log (§23.4, twelve months, then pseudonymised)", () => {
  it("clears what identifies a person and keeps what happened", async () => {
    await ports.db.commit([
      ports.audit.record(auditRow("OLD", hoursAgo(RETENTION_HOURS.auditIdentity + 24))),
      ports.audit.record(auditRow("RECENT", hoursAgo(24))),
    ]);

    const report = await runRetention(ports);
    expect(report.auditPseudonymised).toBe(1);

    const old = ports.state.audit.find((entry) => entry.id === "OLD");
    // Deleting the row would remove the only record that could answer "was this account
    // compromised, and what did the attacker do" — long after anybody remembers the
    // incident. What must go is the material that makes it about a person.
    expect(old).toBeDefined();
    expect(old?.action).toBe("token.issued");
    expect(old?.ipHash).toBeNull();
    expect(old?.userAgent).toBeNull();
    expect(old?.actorPrincipalId).toBeNull();

    const recent = ports.state.audit.find((entry) => entry.id === "RECENT");
    expect(recent?.ipHash).toBe("abc123");
  });

  it("does not rewrite a row it has already pseudonymised", async () => {
    await ports.db.commit([ports.audit.record(auditRow("OLD", hoursAgo(RETENTION_HOURS.auditIdentity + 24)))]);
    await runRetention(ports);
    // Otherwise every pass would report work it did not do, and the "more to do" signal
    // below would never go quiet.
    expect((await runRetention(ports)).auditPseudonymised).toBe(0);
  });
});

/**
 * SPEC §32.2 — content no revision references (the half that did not exist).
 *
 * Erasure depends on this collector and could not say so: §23.3 step 3 refuses to delete an
 * object another revision still points at, so a shared body survives the first erasure by
 * design and is meant to be collected once the last live reference goes. Nothing looked, so
 * it never was.
 */
describe("orphaned content (§32.2)", () => {
  const bodyOf = async (articleId: string, revisionId: string, markdown: string) => {
    const hash = await ports.content.put(markdown);
    // Past the grace period: these tests are about references, not about the write order.
    ports.content.setUploadedAt(hash, hoursAgo(5));
    await ports.db.commit([
      ports.articles.insertArticle({
        id: articleId as never,
        authorPrincipalId: "P" as never,
        language: "en",
        authorshipDisclosure: "human_authored",
        visibility: "public",
        canonicalUrl: null,
        createdAt: hoursAgo(1),
      }),
      ports.articles.insertRevision({
        id: revisionId as never,
        articleId: articleId as never,
        parentRevisionId: null,
        title: "A title",
        excerpt: null,
        contentRef: ports.content.refFor(hash),
        contentHash: hash,
        contentBytes: markdown.length,
        readingTimeSeconds: 1,
        metadata: { schema_version: 1 },
        createdByPrincipalId: "P" as never,
        viaTokenId: null,
        createdAt: hoursAgo(1),
      }),
    ]);
    return hash;
  };

  it("deletes a body once every revision carrying it has been blanked", async () => {
    const hash = await bodyOf("A-GONE", "R-GONE", "# Erased\n\nBody.\n");
    await ports.db.commit([ports.articles.eraseRevisionsOf("A-GONE", hoursAgo(1))]);

    expect(await ports.content.get(hash)).not.toBeNull();
    const report = await runRetention(ports);

    expect(report.orphanedContentDeleted).toBe(1);
    expect(await ports.content.get(hash)).toBeNull();
  });

  /**
   * The object a failed commit left behind (§16.2, §32.2).
   *
   * §16.2 writes the body before the revision row, so a commit that fails leaves an object
   * with no row — and therefore no `content_hash` anywhere in the database. The first
   * version of this collector asked `revisions` which hashes looked unreferenced, so it
   * could not have named this object under any circumstances. For text carrying personal
   * data that is the worst shape available: bytes stored with no entity through which
   * anybody could demand their erasure.
   */
  it("deletes a body no row has ever referenced", async () => {
    const hash = await ports.content.put("# Never committed\n\nBody.\n");
    ports.content.setUploadedAt(hash, hoursAgo(5));

    expect((await runRetention(ports)).orphanedContentDeleted).toBe(1);
    expect(await ports.content.get(hash)).toBeNull();
  });

  it("leaves a body young enough that its row may still be in flight", async () => {
    // The same write order, from the other side: an object seconds old is as likely to be a
    // commit in progress as a commit that failed, and collecting it would make this handler
    // the cause of what it cleans up.
    const hash = await ports.content.put("# Just written\n\nBody.\n");

    expect((await runRetention(ports)).orphanedContentDeleted).toBe(0);
    expect(await ports.content.get(hash)).not.toBeNull();
  });

  /**
   * Progress, which the first version of this had none of.
   *
   * It asked the database for unreferenced hashes and got the same answer every pass:
   * deleting the objects changed no row, so pass two re-read the same first hundred, deleted
   * nothing that was not already gone, reported them as collected again, and never reached
   * the rest. A backlog larger than one batch was permanent, and the report said work was
   * being done. Listing the store instead makes progress the absence of what was collected.
   */
  it("makes progress across passes rather than re-reading the same page", async () => {
    const hashes: string[] = [];
    for (let n = 0; n < 250; n += 1) {
      const hash = await ports.content.put(`# Body ${n}\n\nUnique.\n`);
      ports.content.setUploadedAt(hash, hoursAgo(5));
      hashes.push(hash);
    }

    const report = await runRetention(ports);

    expect(report.orphanedContentDeleted).toBe(250);
    expect(ports.content.size()).toBe(0);
    // And the count is of objects actually removed, not of rows looked at twice.
    expect(report.passes).toBeGreaterThan(1);
  });

  it("leaves a body one live revision still points at", async () => {
    const markdown = "# Shared\n\nSame bytes.\n";
    const hash = await bodyOf("A-ERASED", "R-ERASED", markdown);
    await bodyOf("A-LIVE", "R-LIVE", markdown);
    await ports.db.commit([ports.articles.eraseRevisionsOf("A-ERASED", hoursAgo(1))]);

    expect((await runRetention(ports)).orphanedContentDeleted).toBe(0);
    expect(await ports.content.get(hash)).toBe(markdown);
  });

  it("collects it on the pass after the last reference goes", async () => {
    // The sequence §23.3 leaves behind, and the reason this collector has to exist: two
    // people erase the same bytes, neither erasure may delete the object, and the store is
    // meant to end up empty regardless.
    const markdown = "# Shared\n\nSame bytes.\n";
    const hash = await bodyOf("A-FIRST", "R-FIRST", markdown);
    await bodyOf("A-SECOND", "R-SECOND", markdown);

    await ports.db.commit([ports.articles.eraseRevisionsOf("A-FIRST", hoursAgo(1))]);
    expect((await runRetention(ports)).orphanedContentDeleted).toBe(0);

    await ports.db.commit([ports.articles.eraseRevisionsOf("A-SECOND", hoursAgo(1))]);
    expect((await runRetention(ports)).orphanedContentDeleted).toBe(1);
    expect(await ports.content.get(hash)).toBeNull();
  });

  it("leaves a body nothing has erased", async () => {
    const hash = await bodyOf("A-PUBLISHED", "R-PUBLISHED", "# Published\n\nBody.\n");
    expect((await runRetention(ports)).orphanedContentDeleted).toBe(0);
    expect(await ports.content.get(hash)).not.toBeNull();
  });
});

/** A `ready` record with bytes, created `hours` ago. The shape both media passes start from. */
async function ready(id: string, hours: number): Promise<void> {
  await ports.db.commit([
    ports.media.insert({
      id: id as never,
      ownerPrincipalId: "P1" as never,
      kind: "image",
      altText: null,
      source: "upload",
      generationMetadata: null,
      createdAt: hoursAgo(hours),
    }),
  ]);
  await ports.mediaStore.putDerived(`${id}/original`, bytes(10));
  await ports.db.commit([
    ports.media.markReady(id, {
      storageKey: `${id}/original`,
      contentType: "image/png",
      byteSize: 10,
      checksumSha256: "h",
      finalizedAt: hoursAgo(hours),
    }),
  ]);
}

const bytes = (n: number): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(n));
      controller.close();
    },
  });

describe("media whose bytes never arrived (§21.1, §23.4)", () => {
  it("removes the object before the row", async () => {
    const order: string[] = [];
    const store = {
      ...ports.mediaStore,
      delete: async (key: string) => {
        order.push(`object:${key}`);
        await ports.mediaStore.delete(key);
      },
    };

    await ports.db.commit([
      ports.media.insert({
        id: "M-OLD" as never,
        ownerPrincipalId: "P1" as never,
        kind: "image",
        altText: null,
        source: "upload",
        generationMetadata: null,
        createdAt: hoursAgo(25),
      }),
    ]);

    const report = await runRetention({ ...ports, mediaStore: store });

    expect(report.mediaDeleted).toBe(1);
    // §32.2 — an object with no row is invisible and gets collected; a row with no object
    // promises bytes nobody can fetch. So the object goes first, and a crash between the
    // two leaves the row `pending` for the next pass to find.
    expect(order).toEqual(["object:M-OLD/original"]);
    expect(await ports.media.findById("M-OLD")).toBeNull();
  });

  it("leaves a record whose bytes did arrive, and something points at", async () => {
    await ready("M-USED", 48);
    // The reference is the whole test: the same record with nobody pointing at it is
    // collected by the pass below, and the difference between those two cases is the only
    // thing standing between "collect orphans" and "delete somebody's avatar".
    ports.state.principals.set("P1" as never, {
      id: "P1" as never,
      kind: "human",
      username: "owner",
      usernameSkeleton: "owner",
      displayName: null,
      bio: null,
      status: "active",
      platformRole: "user",
      systemAccount: false,
      avatarMediaId: "M-USED" as never,
      createdAt: hoursAgo(100),
    });

    const report = await runRetention(ports);
    expect(report.mediaDeleted).toBe(0);
    expect(report.orphanedMediaDeleted).toBe(0);
    expect(await ports.media.findById("M-USED")).not.toBeNull();
  });

  it("collects a record the platform detached, with every variant of it", async () => {
    await ready("M-LOOSE", 48);
    await ports.db.commit([ports.media.markDetached("M-LOOSE", hoursAgo(30))]);
    // §21.2 — the objects share a prefix, and a collector that deleted `original` by name
    // would leave four derived objects behind on every record it touched.
    await ports.mediaStore.putDerived("M-LOOSE/avatar", bytes(4));
    await ports.mediaStore.putDerived("M-LOOSE/card", bytes(4));

    const report = await runRetention(ports);

    expect(report.orphanedMediaDeleted).toBe(1);
    expect(await ports.media.findById("M-LOOSE")).toBeNull();
    expect(await ports.mediaStore.get("M-LOOSE/avatar")).toBeNull();
    expect(await ports.mediaStore.get("M-LOOSE/card")).toBeNull();
  });

  it("leaves a ready record nobody attached, however old", async () => {
    // The rule that replaced "collect what nothing references". An article body renders
    // images (§57.1), so a picture can be named in Markdown where no column names it, and
    // inferring "unused" from the absence of a reference would delete it out of a published
    // article. An upload nobody attached is the owner's, and stays.
    await ready("M-UNATTACHED", 500);
    expect((await runRetention(ports)).orphanedMediaDeleted).toBe(0);
    expect(await ports.media.findById("M-UNATTACHED")).not.toBeNull();
  });

  it("leaves a detached record inside its grace period", async () => {
    // §33.2 — a picture cleared a minute ago is still named by pages held in browsers and at
    // the edge. Collecting on the spot turns those into broken images.
    await ready("M-FRESH", 2);
    await ports.db.commit([ports.media.markDetached("M-FRESH", hoursAgo(1))]);
    expect((await runRetention(ports)).orphanedMediaDeleted).toBe(0);
    expect(await ports.media.findById("M-FRESH")).not.toBeNull();
  });

  it("removes the row even when the bucket refuses the object", async () => {
    const store = { ...ports.mediaStore, delete: async () => { throw new Error("bucket unavailable"); } };
    await ports.db.commit([
      ports.media.insert({
        id: "M-STUCK" as never,
        ownerPrincipalId: "P1" as never,
        kind: "image",
        altText: null,
        source: "upload",
        generationMetadata: null,
        createdAt: hoursAgo(25),
      }),
    ]);

    // The row is the thing that makes a promise to a reader; the object is unreachable
    // without it, and an orphan in R2 is the harmless half of the pair (§32.2).
    expect((await runRetention({ ...ports, mediaStore: store })).mediaDeleted).toBe(1);
  });
});

/**
 * SPEC §9.3, §23.4 — the two nonce tables and the delivery record.
 *
 * These are the case §23.4's sentence describes rather than an illustration of it: the D1
 * sweep for the link nonces existed, was reachable through the port, and nothing called it,
 * so both nonce tables and `telegram_deliveries` grew without limit from the day the second
 * channel shipped. The tests below are about the boundary, because the boundary is the only
 * thing that can be wrong here — a sweep that takes one row too many deletes a live
 * credential's record, and one that takes too few is what was already happening.
 */
describe("Telegram nonces (§9.3, §23.4, a day past expiry)", () => {
  const link = (nonce: string, expiresAt: string) => ({
    nonce,
    principalId: "P1" as never,
    createdAt: hoursAgo(30),
    expiresAt,
  });
  const login = (nonce: string, expiresAt: string) => ({
    ...link(nonce, expiresAt),
    chatId: "C1",
  });

  it("collects a link nonce a day past its expiry and keeps a fresher one", async () => {
    await ports.db.commit([
      ports.telegram.insertLink(link("OLD", hoursAgo(RETENTION_HOURS.telegramNonces + 1))),
      ports.telegram.insertLink(link("RECENT", hoursAgo(1))),
    ]);

    const report = await runRetention(ports);

    expect(report.telegramLinksDeleted).toBe(1);
    expect(await ports.telegram.findLink("OLD")).toBeNull();
    // Expired an hour ago, so the row still answers "already used" to a second press.
    expect(await ports.telegram.findLink("RECENT")).not.toBeNull();
  });

  it("collects a login nonce whose message was never taken back", async () => {
    await ports.db.commit([
      ports.telegram.insertLogin(login("SPENT", hoursAgo(RETENTION_HOURS.telegramNonces + 1))),
    ]);
    await ports.db.commit([
      ports.telegram.markLoginUsed("SPENT", hoursAgo(30)),
      ports.telegram.recordLoginMessage("SPENT", "42"),
    ]);

    // `cleanSpentLogins` runs every minute, so a row reaching here uncleaned has had over a
    // thousand attempts. What stays in the chat is a link that stopped working long ago;
    // keeping the row for it would mean the table never empties.
    expect((await runRetention(ports)).telegramLoginsDeleted).toBe(1);
    expect(await ports.telegram.findLogin("SPENT")).toBeNull();
  });

  it("collects a delivery record only once no run could select its event again", async () => {
    await ports.db.commit([
      ports.telegram.markDelivered("E-OLD", hoursAgo(RETENTION_HOURS.telegramDeliveries + 1)),
      ports.telegram.markDelivered("E-RECENT", hoursAgo(2)),
    ]);

    expect((await runRetention(ports)).telegramDeliveriesDeleted).toBe(1);
  });

  it("never lets a swept delivery resurrect a notification", async () => {
    // The whole risk in this sweep: an event inside §9.3's window whose delivery row was
    // collected is an event delivered twice. The cutoff is a day and the window is an hour,
    // so an event still selectable by a run is one whose row this pass cannot reach.
    ports.state.principals.set("P1", {
      id: "P1" as never,
      kind: "human",
      username: "reader",
      usernameSkeleton: "reader",
      displayName: null,
      bio: null,
      status: "active",
      platformRole: "user",
      systemAccount: false,
      avatarMediaId: null,
      createdAt: hoursAgo(48),
    } as never);
    ports.state.telegramAccounts.set("P1", {
      principalId: "P1" as never,
      telegramUserId: "9",
      chatId: "C1",
      username: null,
      linkedAt: hoursAgo(48),
    });
    ports.state.events.push({
      id: "E-RECENT" as never,
      type: "comment.created",
      actorPrincipalId: "P1" as never,
      subjectType: "article",
      subjectId: "A1" as never,
      audiencePrincipalId: "P1" as never,
      visibility: "private",
      payload: { schema_version: 1 },
      createdAt: hoursAgo(0.5),
    } as never);
    await ports.db.commit([ports.telegram.markDelivered("E-RECENT", hoursAgo(0.5))]);

    await runRetention(ports);

    const cutoff = new Date(NOW.getTime() - 3_600_000).toISOString();
    expect(await ports.telegram.listPendingNotifications(cutoff, 10)).toEqual([]);
  });
});

/**
 * SPEC §23.4, §62 — sessions nobody can use, and nothing reads.
 *
 * The table had no bound at all, and what it holds is a user agent and a hashed address: the
 * material §23.4 makes the audit log give up after a year, kept for ever one table over. The
 * assertions are about the two ways this goes wrong — collecting a session somebody is still
 * signed in with, and keeping one they are not.
 */
describe("dead sessions (§23.4, thirty days)", () => {
  const session = (id: string, over: { expiresAt: string; revokedAt?: string }) => ({
    id: id as never,
    principalId: "P1" as never,
    tokenHash: `hash-${id}`,
    userAgent: "Firefox",
    ipHash: "abc123",
    createdAt: hoursAgo(24 * 60),
    lastSeenAt: hoursAgo(24 * 40),
    revokedAt: null,
    ...over,
  });

  it("collects one revoked and one expired past the window", async () => {
    await ports.db.commit([
      ports.sessions.insert(
        session("S-REVOKED", { expiresAt: hoursAgo(-100), revokedAt: hoursAgo(RETENTION_HOURS.deadSessions + 1) }),
      ),
      ports.sessions.insert(session("S-EXPIRED", { expiresAt: hoursAgo(RETENTION_HOURS.deadSessions + 1) })),
    ]);

    expect((await runRetention(ports)).sessionsDeleted).toBe(2);
    expect(await ports.sessions.findByHash("hash-S-REVOKED")).toBeNull();
    expect(await ports.sessions.findByHash("hash-S-EXPIRED")).toBeNull();
  });

  it("keeps a live one, and one that died recently", async () => {
    await ports.db.commit([
      // Signed in right now: the row that must survive every version of this sweep.
      ports.sessions.insert(session("S-LIVE", { expiresAt: hoursAgo(-24 * 20) })),
      // Revoked yesterday. Still inside the window the request logs it made are kept for.
      ports.sessions.insert(session("S-JUST-REVOKED", { expiresAt: hoursAgo(-100), revokedAt: hoursAgo(24) })),
    ]);

    expect((await runRetention(ports)).sessionsDeleted).toBe(0);
    expect(await ports.sessions.findByHash("hash-S-LIVE")).not.toBeNull();
    expect(await ports.sessions.findByHash("hash-S-JUST-REVOKED")).not.toBeNull();
  });
});

describe("bounded passes", () => {
  it("does nothing and says so on an empty database", async () => {
    expect(await runRetention(ports)).toEqual({
      canaryArticlesDeleted: 0,
      deadLettersDeleted: 0,
      outboxDeleted: 0,
      idempotencyDeleted: 0,
      mediaDeleted: 0,
      orphanedMediaDeleted: 0,
      orphanedContentDeleted: 0,
      auditPseudonymised: 0,
      telegramLinksDeleted: 0,
      telegramLoginsDeleted: 0,
      telegramDeliveriesDeleted: 0,
      sessionsDeleted: 0,
      passes: 1,
      moreToDo: false,
    });
  });

  /**
   * The batch is a per-pass ceiling, not a per-day one.
   *
   * `moreToDo` was returned, logged and read by nobody, which quietly capped retention at one
   * batch per table per day — the cron runs once. These two prove the loop: it comes back for
   * what a full batch left behind, and when the passes run out it says so instead of looking
   * like a clean run.
   */
  /**
   * The batch is a per-pass ceiling, not a per-day one.
   *
   * `moreToDo` was returned, logged and read by nobody, which quietly capped retention at one
   * batch per table per day — the cron runs once. These two drive the real constant rather
   * than a shrunken double, because what is being tested is the loop around it.
   */
  const staleOutbox = async (count: number) => {
    const ids = Array.from({ length: count }, (_, n) => `OLD-${n}`);
    await ports.db.commit(
      ids.map((id) => ports.outbox.enqueue(outboxRow(id, hoursAgo(RETENTION_HOURS.outbox + 1)))),
    );
    await ports.db.commit([ports.outbox.markSent(ids, NOW.toISOString())]);
  };

  it("comes back for what a full batch left behind", async () => {
    await staleOutbox(RETENTION_BATCH + 3);

    const report = await runRetention(ports);

    expect(report.outboxDeleted).toBe(RETENTION_BATCH + 3);
    // Two passes: the first fills its batch and says so, the second finds three and stops.
    expect(report.passes).toBe(2);
    expect(report.moreToDo).toBe(false);
  });

  it("stops after the pass ceiling and admits it is behind", async () => {
    await staleOutbox(RETENTION_BATCH * 2 + 1);

    const report = await runRetention(ports, 2);

    // `moreToDo` meaning what it now means: the passes ran out with a table still full. The
    // cron logs that at error level, because it is a fact about the schedule rather than a
    // count of work done.
    expect(report.outboxDeleted).toBe(RETENTION_BATCH * 2);
    expect(report.passes).toBe(2);
    expect(report.moreToDo).toBe(true);
  });
});

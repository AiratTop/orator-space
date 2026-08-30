import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { RETENTION_HOURS, runRetention } from "./retention.js";

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

describe("bounded passes", () => {
  it("does nothing and says so on an empty database", async () => {
    expect(await runRetention(ports)).toEqual({
      canaryArticlesDeleted: 0,
      deadLettersDeleted: 0,
      outboxDeleted: 0,
      idempotencyDeleted: 0,
      mediaDeleted: 0,
      orphanedMediaDeleted: 0,
      auditPseudonymised: 0,
      telegramLinksDeleted: 0,
      telegramLoginsDeleted: 0,
      telegramDeliveriesDeleted: 0,
      moreToDo: false,
    });
  });
});

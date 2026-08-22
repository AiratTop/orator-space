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

  it("leaves a record whose bytes did arrive", async () => {
    await ports.db.commit([
      ports.media.insert({
        id: "M-READY" as never,
        ownerPrincipalId: "P1" as never,
        kind: "image",
        altText: null,
        source: "upload",
        generationMetadata: null,
        createdAt: hoursAgo(48),
      }),
    ]);
    await ports.db.commit([
      ports.media.markReady("M-READY", {
        storageKey: "M-READY/original",
        contentType: "image/png",
        byteSize: 10,
        checksumSha256: "h",
        finalizedAt: hoursAgo(47),
      }),
    ]);

    expect((await runRetention(ports)).mediaDeleted).toBe(0);
    expect(await ports.media.findById("M-READY")).not.toBeNull();
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

describe("bounded passes", () => {
  it("does nothing and says so on an empty database", async () => {
    expect(await runRetention(ports)).toEqual({
      canaryArticlesDeleted: 0,
      outboxDeleted: 0,
      idempotencyDeleted: 0,
      mediaDeleted: 0,
      auditPseudonymised: 0,
      moreToDo: false,
    });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { SCHEMA_VERSION } from "@orator/protocol";
import { drainOutbox } from "./outbox.js";

let ports: ReturnType<typeof createMemoryPorts>;

beforeEach(() => {
  ports = createMemoryPorts();
});

async function enqueue(n: number) {
  const writes = Array.from({ length: n }, (_, i) =>
    ports.outbox.enqueue({
      id: ports.ids.next(),
      eventType: "article.published",
      aggregateType: "article",
      aggregateId: `ARTICLE-${i}`,
      payload: { schema_version: SCHEMA_VERSION },
      requestId: "REQ",
      createdAt: ports.clock.now().toISOString(),
    }),
  );
  await ports.db.commit(writes);
}

describe("outbox drain (SPEC §35.2)", () => {
  it("does nothing when there is nothing pending", async () => {
    expect(await drainOutbox(ports)).toEqual({ delivered: 0, failed: 0, remaining: 0 });
    expect(ports.published).toHaveLength(0);
  });

  it("delivers pending rows and marks them sent", async () => {
    await enqueue(3);
    const result = await drainOutbox(ports);
    expect(result.delivered).toBe(3);
    expect(result.remaining).toBe(0);
    expect(ports.published[0]).toHaveLength(3);
  });

  it("does not deliver the same row twice", async () => {
    await enqueue(2);
    await drainOutbox(ports);
    const second = await drainOutbox(ports);
    expect(second.delivered).toBe(0);
    expect(ports.published).toHaveLength(1);
  });

  it("delivers in id order, which is creation order", async () => {
    await enqueue(5);
    await drainOutbox(ports);
    const ids = ports.published[0]!.map((entry) => entry.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it("leaves rows pending when delivery fails, rather than losing them", async () => {
    // This is the entire reason the table exists: the send is not transactional with
    // the write, so a failure must be recoverable rather than silent (§35.1).
    await enqueue(2);
    ports.failBus(new Error("queue unavailable"));
    const result = await drainOutbox(ports);
    expect(result.failed).toBe(2);
    expect(result.remaining).toBe(2);
  });

  it("backs off before retrying, then succeeds", async () => {
    await enqueue(1);
    ports.failBus(new Error("queue unavailable"));
    await drainOutbox(ports);

    // Immediately after the failure the row is not yet due.
    ports.failBus(null);
    expect((await drainOutbox(ports)).delivered).toBe(0);

    // Once the backoff has elapsed it is delivered.
    ports.setNow(new Date(Date.parse("2026-08-21T12:00:00.000Z") + 60_000));
    expect((await drainOutbox(ports)).delivered).toBe(1);
  });

  it("lengthens the backoff with each failure, so a poison row cannot monopolise the drain", async () => {
    await enqueue(1);
    ports.failBus(new Error("still broken"));

    const attempts = [0, 1, 2, 3];
    const delays: number[] = [];
    for (const attempt of attempts) {
      const base = Date.parse("2026-08-21T12:00:00.000Z") + attempt * 3_600_000;
      ports.setNow(new Date(base));
      await drainOutbox(ports);
      // Find the smallest offset at which the row becomes due again.
      let offset = 1_000;
      while (offset < 30 * 60 * 1000) {
        ports.setNow(new Date(base + offset));
        if ((await ports.outbox.listPending(ports.clock.now().toISOString(), 10)).length > 0) break;
        offset *= 2;
      }
      delays.push(offset);
      ports.setNow(new Date(base));
    }
    expect(delays[3]!).toBeGreaterThan(delays[0]!);
  });

  it("honours the batch limit, so one drain cannot exceed D1's parameter cap", async () => {
    await enqueue(30);
    const result = await drainOutbox(ports, 10);
    expect(result.delivered).toBe(10);
    expect(result.remaining).toBe(20);
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createSloRepo, recordDeadLetter } from "./slo.js";

/**
 * The §66.4 queries against a real database.
 *
 * Two of them are the kind that pass against a double and fail against SQL: the indexing lag
 * joins two tables and subtracts two text timestamps, and the dead-letter recorder leans on a
 * partial unique index to make a redelivery one row rather than several. Neither is visible
 * to a test that only exercises the shape.
 */

const repo = () => createSloRepo(env.DB);
const AT = (minute: number) => `2026-08-23T12:${String(minute).padStart(2, "0")}:00.000Z`;

async function article(id: string, publishedAt: string | null): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO principals (id, kind, username, username_skeleton, created_at, updated_at)
       VALUES ('P1', 'agent', 'researcher', 'researcher', ?, ?)`,
    ).bind(AT(0), AT(0)),
    env.DB.prepare(
      `INSERT INTO articles (id, author_principal_id, status, visibility, authorship_disclosure,
                             created_at, updated_at, published_at)
       VALUES (?, 'P1', 'published', 'public', 'ai_generated', ?, ?, ?)`,
    ).bind(id, AT(0), AT(0), publishedAt),
  ]);
}

const indexed = (articleId: string, at: string) =>
  env.DB.prepare(
    `INSERT INTO search_docs (article_id, content_hash, indexed_at) VALUES (?, 'h', ?)`,
  ).bind(articleId, at);

const outboxRow = (id: string, createdAt: string, status: string) =>
  env.DB.prepare(
    `INSERT INTO outbox (id, event_type, aggregate_type, aggregate_id, payload_json, status,
                         attempts, created_at)
     VALUES (?, 'article.published', 'article', 'A1', '{}', ?, 0, ?)`,
  ).bind(id, status, createdAt);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM dead_letters`),
    env.DB.prepare(`DELETE FROM outbox`),
    env.DB.prepare(`DELETE FROM search_docs`),
    env.DB.prepare(`DELETE FROM articles`),
    env.DB.prepare(`DELETE FROM principals`),
  ]);
});

describe("the outbox backlog", () => {
  it("counts only what is still pending, and names the oldest", async () => {
    await env.DB.batch([
      outboxRow("O1", AT(1), "sent"),
      outboxRow("O2", AT(2), "pending"),
      outboxRow("O3", AT(3), "pending"),
    ]);

    expect(await repo().outboxBacklog()).toEqual({ pending: 2, oldestPendingAt: AT(2) });
  });

  it("says nothing is waiting rather than inventing a date", async () => {
    expect(await repo().outboxBacklog()).toEqual({ pending: 0, oldestPendingAt: null });
  });
});

describe("published to indexed (§34.4, §66.4)", () => {
  it("measures the gap between the two timestamps", async () => {
    await article("A1", AT(0));
    await indexed("A1", AT(1)).run();

    expect(await repo().indexingLag(50)).toEqual({ sampled: 1, p95Seconds: 60 });
  });

  it("takes the 95th percentile of the sample, not the worst value", async () => {
    // Twenty articles: nineteen indexed in a second, one in ten minutes. The nearest-rank
    // p95 of twenty values is the nineteenth, so the outlier is excluded — which is what a
    // percentile is for and what a max would get wrong.
    for (let i = 0; i < 20; i++) {
      await article(`A${i}`, AT(0));
      await indexed(`A${i}`, i === 19 ? AT(10) : "2026-08-23T12:00:01.000Z").run();
    }

    const lag = await repo().indexingLag(50);
    expect(lag.sampled).toBe(20);
    expect(lag.p95Seconds).toBe(1);
  });

  it("drops a negative gap, which means two clocks rather than a fast index", async () => {
    await article("A1", AT(5));
    await indexed("A1", AT(1)).run();

    expect(await repo().indexingLag(50)).toEqual({ sampled: 0, p95Seconds: null });
  });

  it("has no percentile when nothing has been indexed", async () => {
    expect(await repo().indexingLag(50)).toEqual({ sampled: 0, p95Seconds: null });
  });
});

describe("dead letters (§66.4)", () => {
  it("records an arrival and counts it within the window", async () => {
    const record = recordDeadLetter(env.DB);
    await record({
      id: "D1",
      eventId: "E1",
      eventType: "article.published",
      aggregateId: "A1",
      error: "boom",
      arrivedAt: AT(5),
    });

    expect(await repo().deadLettered(AT(0))).toBe(1);
    expect(await repo().deadLettered(AT(6))).toBe(0);
  });

  it("counts one event once, however many times the queue redelivers it", async () => {
    const record = recordDeadLetter(env.DB);
    const entry = { eventId: "E1", eventType: "t", aggregateId: "A1", error: null, arrivedAt: AT(5) };
    await record({ ...entry, id: "D1" });
    await record({ ...entry, id: "D2" });

    expect(await repo().deadLettered(AT(0))).toBe(1);
  });

  it("records every message that had no id to key on", async () => {
    // The failure with the least information attached, and the one worth seeing twice rather
    // than losing to a unique index it cannot participate in.
    const record = recordDeadLetter(env.DB);
    const entry = { eventId: null, eventType: null, aggregateId: null, error: null, arrivedAt: AT(5) };
    await record({ ...entry, id: "D1" });
    await record({ ...entry, id: "D2" });

    expect(await repo().deadLettered(AT(0))).toBe(2);
  });

  it("deletes in bounded passes (§23.4)", async () => {
    const record = recordDeadLetter(env.DB);
    for (let i = 0; i < 3; i++) {
      await record({ id: `D${i}`, eventId: `E${i}`, eventType: null, aggregateId: null, error: null, arrivedAt: AT(1) });
    }

    expect(await repo().deleteDeadLettersBefore(AT(5), 2)).toBe(2);
    expect(await repo().deleteDeadLettersBefore(AT(5), 2)).toBe(1);
    expect(await repo().deadLettered(AT(0))).toBe(0);
  });
});

describe("the database's size", () => {
  it("comes from the metadata of a statement, so nothing has to be counted", async () => {
    // Asserted as a number rather than as a value: the point is that D1 answers at all, and
    // where it does not, the null path turns into "unavailable" rather than a reassuring zero.
    const bytes = await repo().databaseBytes();
    expect(typeof bytes).toBe("number");
    expect(bytes).toBeGreaterThan(0);
  });
});

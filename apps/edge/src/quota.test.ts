import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createQuotaGate, type QuotaCounter } from "@orator/adapters-cf";

/**
 * The quota counter against a real Durable Object (SPEC §59.1).
 *
 * The rule is tested in the domain, where it is a function. What can only be tested here is
 * that the object is the right object: that two calls for the same principal reach the same
 * counter, that two principals do not share one, and that a stale window reads as zero
 * rather than as whatever was left in storage. Those are the properties that make the count
 * exact, and a double cannot have them wrong.
 *
 * Here rather than beside the adapter because a Durable Object is only real once a Worker
 * exports the class and a binding names it. That happens in this app, and the test pool
 * needs the same entrypoint to resolve the namespace at all.
 */

const gate = () => createQuotaGate(env.QUOTA as DurableObjectNamespace<QuotaCounter>);

const suffix = () => Math.random().toString(36).slice(2, 8);
let principal: string;

beforeEach(() => {
  // A fresh name each time: a Durable Object is durable, and re-using one across tests
  // would make every count depend on the order they ran in.
  principal = `P-${suffix()}`;
});

describe("counting", () => {
  it("counts each use against the same object", async () => {
    const q = gate();
    const first = await q.consume(principal, "articles.publish", 1);
    const second = await q.consume(principal, "articles.publish", 1);

    expect(first.remaining).toBe(19);
    expect(second.remaining).toBe(18);
  });

  it("keeps one principal's count away from another's", async () => {
    const q = gate();
    await q.consume(principal, "comments", 1);
    await q.consume(principal, "comments", 1);

    const other = await q.consume(`P-${suffix()}`, "comments", 1);
    expect(other.remaining).toBe(59);
  });

  it("counts each action separately", async () => {
    const q = gate();
    await q.consume(principal, "comments", 1);

    const edges = await q.peek(principal, 1);
    expect(edges.find((entry) => entry.action === "comments")?.remaining).toBe(59);
    expect(edges.find((entry) => entry.action === "edges")?.remaining).toBe(100);
  });

  it("refuses once the limit is passed, and keeps counting", async () => {
    const q = gate();
    // Level 0 is a quarter of the baseline: ten agents becomes three (§60.2).
    for (let i = 0; i < 3; i += 1) expect((await q.consume(principal, "agents", 0)).allowed).toBe(true);

    const refused = await q.consume(principal, "agents", 0);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);

    // The count rises even when the answer is no: a counter that stopped at the limit would
    // let a caller hammer the endpoint at no cost and leave no trace anything had tried.
    const again = await q.consume(principal, "agents", 0);
    expect(again.allowed).toBe(false);
  });
});

describe("peeking", () => {
  it("spends nothing", async () => {
    const q = gate();
    await q.consume(principal, "media", 1);

    await q.peek(principal, 1);
    await q.peek(principal, 1);

    expect((await q.peek(principal, 1)).find((e) => e.action === "media")?.remaining).toBe(199);
  });

  it("reports every action, including the untouched ones", async () => {
    const entries = await gate().peek(principal, 1);
    expect(entries).toHaveLength(7);
    expect(entries.every((entry) => entry.remaining === entry.limit)).toBe(true);
  });

  it("answers at the trust level it was asked about", async () => {
    const q = gate();
    const low = await q.peek(principal, 0);
    const high = await q.peek(principal, 3);

    const limitOf = (entries: typeof low, action: string) =>
      entries.find((entry) => entry.action === action)?.limit ?? 0;
    expect(limitOf(high, "articles.publish")).toBeGreaterThan(limitOf(low, "articles.publish"));
  });
});

describe("the window", () => {
  it("reads a counter from an older window as zero", async () => {
    const q = gate();
    await q.consume(principal, "comments", 1);

    // Reaching into the object rather than waiting an hour. The stored window is what makes
    // a stale counter read as empty, so backdating it is exactly the state under test.
    const id = env.QUOTA.idFromName(principal);
    await runInDurableObject(env.QUOTA.get(id), async (_instance, state) => {
      await state.storage.put("comments", { window: 0, count: 59 });
    });

    expect((await q.consume(principal, "comments", 1)).remaining).toBe(59);
  });

  it("sets one cleanup alarm rather than one per write", async () => {
    const q = gate();
    await q.consume(principal, "comments", 1);

    const id = env.QUOTA.idFromName(principal);
    const first = await runInDurableObject(env.QUOTA.get(id), (_i, state) => state.storage.getAlarm());
    expect(first).not.toBeNull();

    await q.consume(principal, "comments", 1);
    const second = await runInDurableObject(env.QUOTA.get(id), (_i, state) => state.storage.getAlarm());
    // An active principal must not reschedule on every write; the alarm exists so an idle
    // one stops costing storage (§67.2), not to be rewritten sixty times an hour.
    expect(second).toBe(first);
  });
});

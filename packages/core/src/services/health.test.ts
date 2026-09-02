import { beforeEach, describe, expect, it } from "vitest";
import { ErrorType } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { deepHealth } from "./health.js";

/**
 * The deep check (SPEC §66.7).
 *
 * The one test that matters here is the one about *reporting*: this check exists because
 * every endpoint can answer 200 while the asynchronous half is stopped, and a check that
 * says "ok" when a step failed would be the same failure one level up. So the assertions are
 * about what it says when something is broken, not about the happy path.
 *
 * It is also a writing endpoint reachable over HTTP, which makes who may run it a security
 * question rather than a tidiness one.
 */

let ports: ReturnType<typeof createMemoryPorts>;

const CANARY = "SYSTEM-CANARY";
const ORDINARY = "AGENT-A";

const actorFor = (principalId: string, systemAccount: boolean): Actor => ({
  principalId,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: "OWNER-H",
  status: "active",
  trustLevel: 1,
  systemAccount,
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

beforeEach(() => {
  ports = createMemoryPorts();
  for (const [id, system] of [[CANARY, true], [ORDINARY, false]] as const) {
    ports.state.principals.set(id, {
      id: id as never,
      kind: "agent",
      username: system ? "orator-canary" : "researcher",
      usernameSkeleton: system ? "orator-canary" : "researcher",
      displayName: null,
      bio: null,
      status: "active",
      platformRole: "user",
      systemAccount: system,
      avatarMediaId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      ownerPrincipalId: "OWNER-H" as never,
      trustLevel: 1,
    });
  }
});

describe("who may run it (§66.7)", () => {
  it("refuses an ordinary principal, however well scoped", async () => {
    // It publishes. An endpoint that writes and is reachable without being the canary is an
    // abuse surface however narrow its purpose.
    const result = await deepHealth(ctxFor(actorFor(ORDINARY, false)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe(ErrorType.Forbidden);
  });

  it("refuses an anonymous caller", async () => {
    const result = await deepHealth(ctxFor(null));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe(ErrorType.Unauthenticated);
  });
});

describe("what it reports (§66.7, §66.4)", () => {
  it("publishes, waits for the index, and takes the article away again", async () => {
    /*
     * The index is answered by a double that reports whatever exists.
     *
     * In the real system the step is satisfied by the queue consumer writing `search_docs`;
     * in memory nothing runs that consumer, so a faithful double would mean this test asserts
     * the timeout rather than the sequence. What is under test here is the order of the steps
     * and the cleanup, not the indexing pipeline — that is what the checkpoint is for.
     */
    const indexed = {
      ...ports,
      search: { ...ports.search, query: async () => [...ports.state.articles.keys()] as never },
    };
    const report = unwrap(
      await deepHealth({ ...ctxFor(actorFor(CANARY, true)), ports: indexed }, { indexTimeoutMs: 200 }),
    );

    expect(report.status).toBe("ok");
    expect(report.steps.map((step) => step.name)).toEqual(["create", "publish", "indexed", "remove"]);
    // §66.7 — a canary that leaves its article behind fills the database with evidence of
    // its own runs. The removal is a measured step for exactly that reason.
    expect(report.steps.every((step) => step.ok)).toBe(true);
  });

  it("hands the outbox to the queue itself rather than leaving it for the cron (§35.2)", async () => {
    /*
     * Every write route drains the outbox in the background right after responding. This
     * check reaches the service directly, so before it did the same its publish event waited
     * for the cron — one minute at its shortest, against a timeout of forty-five seconds.
     * The check reported the pipeline stopped on nearly every run against staging.
     */
    const indexed = {
      ...ports,
      search: { ...ports.search, query: async () => [...ports.state.articles.keys()] as never },
    };
    unwrap(await deepHealth({ ...ctxFor(actorFor(CANARY, true)), ports: indexed }, { indexTimeoutMs: 200 }));

    const types = ports.published.flat().map((entry) => entry.eventType);
    expect(types).toContain("article.published");
  });

  it("says degraded when the asynchronous half never delivers", async () => {
    // The failure this check exists for: every synchronous call succeeds and the article
    // never becomes findable. A shallow probe reports a healthy platform here.
    const stalled = { ...ports, search: { ...ports.search, query: async () => [] as never } };
    const report = unwrap(
      await deepHealth({ ...ctxFor(actorFor(CANARY, true)), ports: stalled }, { indexTimeoutMs: 50 }),
    );

    expect(report.status).toBe("degraded");
    expect(report.steps.find((step) => step.name === "indexed")?.ok).toBe(false);
    // And it still cleans up after itself on the unhealthy path.
    expect(report.steps.find((step) => step.name === "remove")?.ok).toBe(true);
  });

  it("checks the public page when it is given a way to read one", async () => {
    const asked: string[] = [];
    const report = unwrap(
      await deepHealth({
        ...ctxFor(actorFor(CANARY, true)),
        ports: { ...ports, search: { ...ports.search, query: async () => [...ports.state.articles.keys()] as never } },
      }, {
        indexTimeoutMs: 200,
        fetchPublic: async (path) => {
          asked.push(path);
          return { status: 500, body: "" };
        },
      }),
    );

    expect(asked).toHaveLength(1);
    expect(report.status).toBe("degraded");
    expect(report.steps.find((step) => step.name === "public")?.detail).toContain("500");
  });
});

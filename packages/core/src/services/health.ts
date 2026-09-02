import { ErrorType } from "@orator/protocol";
import { createArticle, publishArticle } from "./publishing.js";
import { removeArticle } from "./lifecycle.js";
import { drainOutbox } from "./outbox.js";
import { fail, ok, type RequestContext, type Result } from "./context.js";

/**
 * The deep health check (SPEC §66.7).
 *
 * `/health` asks whether the dependencies answer. This asks the only question that matters
 * about this architecture, and no shallow check can: **the API returns 201, the page opens,
 * and the asynchronous pipeline is stopped.** Publishing is a pointer move (§16.3); search,
 * the sitemap, the cache and the events all happen afterwards, on a queue. Every one of them
 * can be dead while every endpoint reports success.
 *
 * So the check publishes something and waits for it to become findable — a synthetic
 * transaction rather than a probe. It reports the latency of each step, which is what makes
 * it useful before an outage rather than during one: "indexing took 40 seconds today" is a
 * warning, and §66.4 sets the threshold at a p95 of 60.
 */

export interface HealthStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface DeepHealth {
  status: "ok" | "degraded";
  steps: HealthStep[];
  totalMs: number;
}

export interface DeepHealthOptions {
  /** How long to wait for the asynchronous half before calling it stopped. */
  indexTimeoutMs?: number;
  /** Reads the article back through its public address. Null skips that step. */
  fetchPublic?: ((path: string) => Promise<{ status: number; body: string }>) | null;
}

/**
 * §66.7 — the canary's identity is checked, not assumed.
 *
 * Running this as an ordinary principal would publish into the feed, spend a quota and
 * count as activity. Requiring a system account is also what makes the endpoint safe to
 * expose: it writes, and an unauthenticated endpoint that writes is an abuse surface however
 * narrow its purpose.
 */
export async function deepHealth(
  ctx: RequestContext,
  options: DeepHealthOptions = {},
): Promise<Result<DeepHealth>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");
  if (!actor.systemAccount) {
    return fail(
      ErrorType.Forbidden,
      "The deep check runs as a system account",
      "It publishes and removes an article. Give the canary its own principal (§66.7).",
    );
  }

  const timeout = options.indexTimeoutMs ?? 45_000;
  const steps: HealthStep[] = [];
  const startedAt = Date.now();

  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    const began = Date.now();
    try {
      const value = await run();
      steps.push({ name, ok: true, ms: Date.now() - began });
      return value;
    } catch (error) {
      steps.push({ name, ok: false, ms: Date.now() - began, detail: String(error).slice(0, 200) });
      return null;
    }
  };

  const marker = `orator-canary-${Date.now().toString(36)}`;
  const body = [
    `# Deep health check ${marker}`,
    "",
    "This article was published by the platform's own canary to prove that the asynchronous",
    "pipeline moves, and is removed within seconds of being read back. It is excluded from",
    "feeds, search results, metrics and the sitemap (§66.7).",
    "",
    `Marker: ${marker}`,
  ].join("\n");

  const draft = await step("create", async () => {
    const result = await createArticle(ctx, { title: `Deep health check ${marker}`, content: body });
    if (!result.ok) throw new Error(result.error.title);
    return result.value;
  });

  if (draft !== null) {
    await step("publish", async () => {
      const result = await publishArticle(ctx, draft.id);
      if (!result.ok) throw new Error(result.error.title);

      /*
       * Publishing includes handing the outbox to the queue (§35.2).
       *
       * Every write route does this in `waitUntil` right after responding, so a client's
       * article is on the queue within a second of the 200. This check reached the service
       * directly and did not, which left its event for the cron — the safety net, at a
       * minimum interval of one minute against a timeout of forty-five seconds. The check
       * then reported the pipeline stopped, on almost every run, while it was working.
       *
       * The drain reports its failures in its result rather than throwing, and the outcome
       * of one is not this step's to judge: a hand-off that did not happen shows up as the
       * `indexed` step timing out, which is the observable property §66.7 is about.
       */
      await drainOutbox(ctx.ports);
      return result.value;
    });

    /*
     * The step the whole check exists for.
     *
     * Everything above is synchronous and would pass with the queue consumer dead. This is
     * the first thing that requires the outbox to drain, the consumer to run and the index
     * to be written — the failure §66.7 calls this architecture's principal one.
     */
    await step("indexed", async () => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = await ctx.ports.search.query(marker, 5);
        if (found.includes(draft.id)) return true;
        if (Date.now() > deadline) throw new Error(`not indexed within ${timeout} ms`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });

    if (options.fetchPublic !== null && options.fetchPublic !== undefined) {
      await step("public", async () => {
        const response = await options.fetchPublic!(draft.url);
        if (response.status !== 200) throw new Error(`public page answered ${response.status}`);
        if (!response.body.includes(marker)) throw new Error("the page did not carry the marker");
        return true;
      });
    }

    /*
     * Removal is a step, not cleanup.
     *
     * §23.2's tombstone is part of the write path and can fail on its own, so a check that
     * removed the article outside the measured steps would report health while the operation
     * a moderator depends on was broken. It also has to happen even when a step above failed
     * — a canary that leaves an article behind on every unhealthy run fills the database
     * with evidence of the outage.
     */
    await step("remove", async () => {
      const result = await removeArticle(ctx, draft.id);
      if (!result.ok) throw new Error(result.error.title);
      return result.value;
    });
  }

  return ok({
    status: steps.every((entry) => entry.ok) ? "ok" : "degraded",
    steps,
    totalMs: Date.now() - startedAt,
  });
}

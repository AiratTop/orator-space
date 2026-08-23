/**
 * apps/edge — api.orator.space, mcp.orator.space and media.orator.space in one Worker,
 * routed by hostname (SPEC §63). Also hosts the queue consumers and cron triggers.
 *
 * REST and MCP are adapters over the same application services (SPEC §29, §41);
 * neither owns business logic and neither talks to storage directly (SPEC §28.1).
 */
import { Hono, type Context, type Next } from "hono";
import {
  createIdGen,
  createMetricsQuery,
  createSloRepo,
  QuotaCounter,
  recordDeadLetter,
  systemClock,
} from "@orator/adapters-cf";
import { problem, ErrorType, PROTOCOL_VERSION } from "@orator/protocol";
import type { RequestContext } from "@orator/core";
import { contextFor } from "./context.js";
import { deepHealth } from "@orator/core";
import { problemResponse } from "./http.js";
import { identityRoutes } from "./routes/identity.js";
import { articleRoutes } from "./routes/articles.js";
import { socialRoutes } from "./routes/social.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { mediaRoutes } from "./routes/media.js";
import { mcpRoutes } from "./routes/mcp.js";
import { moderationRoutes } from "./routes/moderation.js";
import { portsFor } from "./context.js";
import {
  applyClosureDisposition,
  drainOutbox,
  evaluateIndexability,
  evaluateSlo,
  markArticleShard,
  rebuildSitemap,
  reindexArticle,
  runRetention,
  screenArticle,
} from "@orator/core";

export interface Env {
  ENVIRONMENT: string;
  /** The public site's hostname (ADR 0003). The sitemap is a list of its URLs (§51). */
  SITE_HOST: string;
  DB: D1Database;
  CONTENT: R2Bucket;
  MEDIA: R2Bucket;
  ASSETS_BUCKET: R2Bucket;
  EVENTS: Queue;
  /** SPEC §59.1 — one object per principal; the exact half of the two mechanisms. */
  QUOTA: DurableObjectNamespace<QuotaCounter>;
  /** SPEC §59.1 — the approximate half: per-colo flood protection, per IP and per token. */
  FLOOD: RateLimit;
  /** §59.2 names search separately, and the binding's limit is fixed per binding. */
  FLOOD_SEARCH: RateLimit;
  /** SPEC §66.2 — metrics and high-cardinality telemetry. Never D1. */
  METRICS?: AnalyticsEngineDataset;
  /**
   * SPEC §66.4 — reading back what §66.2 wrote.
   *
   * The binding above writes and cannot read; the SQL API reads and needs an account-scoped
   * credential. All three are optional, and their absence is a state the SLO report names
   * rather than an error: two of the seven indicators say "unavailable" and the other five
   * still answer.
   */
  METRICS_DATASET?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
}

type Surface = "api" | "mcp" | "media" | "unknown";

/**
 * SPEC §63 — one Worker, three public surfaces, distinguished by Host.
 *
 * Staging uses `api-staging.orator.space` rather than `api.staging.orator.space`:
 * Cloudflare's Universal SSL covers the apex and one level of subdomain, so a
 * second-level name would attach as a route and then fail TLS (ADR 0003).
 */
export function surfaceFor(hostname: string): Surface {
  const label = (hostname.split(".")[0] ?? "").replace(/-(staging|preview)$/, "");
  if (label === "api" || label === "mcp" || label === "media") return label;
  return "unknown";
}

const idGen = createIdGen();

type Vars = { requestId: string; ctx: RequestContext };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/** SPEC §66.1 — a request id exists from the first middleware and travels to the consumer. */
app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? idGen.next();
  c.set("requestId", requestId);
  await next();
  c.header("x-request-id", requestId);
});

/**
 * Nothing on these hostnames belongs in a search index (SPEC §50, §57.4).
 *
 * `robots.txt` is fetched per host, and until now these three answered it with a 404 —
 * which a crawler reads as "no directives, help yourself". None of the three is a place a
 * search result should point:
 *
 *   api    JSON documents that duplicate pages which have their own canonical addresses
 *   mcp    a JSON-RPC endpoint that answers nothing at all to a GET
 *   media  user-uploaded files on an isolated origin. §50.3 makes indexing something an
 *          article earns; a file indexed on its own would route a reader around that
 *          decision and around the page that says who published it.
 *
 * `orator.space` keeps its own permissive robots.txt: reading is the product, and blocking
 * crawlers there would contradict it (§48). This is about three hostnames that serve
 * machinery, not writing.
 */
app.get("/robots.txt", (c) =>
  c.body(
    [
      `# ${surfaceFor(new URL(c.req.url).hostname)}.orator.space serves machinery, not writing.`,
      "# The articles are at https://orator.space, and reading them is permitted there.",
      "",
      "User-agent: *",
      "Disallow: /",
      "",
    ].join("\n"),
    200,
    { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" },
  ),
);

/**
 * The same statement in a header, for anything that fetched a URL without asking first.
 *
 * `robots.txt` is a directive a crawler chooses to read; `X-Robots-Tag` travels with the
 * response it applies to. Both, because the two are honoured by different clients and a
 * URL that reached an index through a link nobody crawled is exactly the case robots.txt
 * cannot cover.
 */
app.use("*", async (c, next) => {
  await next();
  c.header("x-robots-tag", "noindex, nofollow");
});

/** SPEC §66.4 — shallow check: are the dependencies reachable at all. */
app.get("/health", async (c) => {
  const checks: Record<string, boolean> = {};
  try {
    await c.env.DB.prepare("SELECT 1").first();
    checks.d1 = true;
  } catch {
    checks.d1 = false;
  }
  try {
    await c.env.CONTENT.head("health-probe");
    checks.r2 = true;
  } catch {
    checks.r2 = false;
  }
  const healthy = Object.values(checks).every(Boolean);
  return c.json(
    { status: healthy ? "ok" : "degraded", environment: c.env.ENVIRONMENT, protocol: PROTOCOL_VERSION, checks },
    healthy ? 200 : 503,
  );
});

/**
 * Fixture data for local development (PLAN.md §4). Registered only outside production —
 * a route that wipes and rewrites the database has no business existing there at all,
 * rather than existing and being guarded by a check someone could get wrong.
 */
app.post("/dev/seed", async (c) => {
  if (c.env.ENVIRONMENT === "production") {
    return c.json(
      problem(ErrorType.NotFound, "Resource not found", { request_id: c.get("requestId") }),
      404,
      { "content-type": "application/problem+json" },
    );
  }
  const { seed } = await import("./dev-seed.js");
  return c.json(await seed(c.env));
});

/**
 * The request context resolves the bearer token, which costs a D1 read. Scoped to /v1 so
 * that health checks and media reads neither pay for it nor depend on authentication
 * working — a health endpoint that fails when the token table is unreachable reports the
 * wrong thing (SPEC §66.4).
 */
const resolveContext = async (c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) => {
  // §66.5 — the surface is what the Worker knows and a client cannot claim, so it is passed
  // in rather than inferred from anything the request said about itself.
  const surface = surfaceFor(new URL(c.req.url).hostname);
  c.set("ctx", await contextFor(c.req.raw, c.env, c.get("requestId"), surface === "unknown" ? "api" : surface));
  await next();
};

/**
 * SPEC §59.1 — flood protection, in front of everything that costs storage.
 *
 * The approximate half of the two mechanisms, and deliberately so. This counter is per-colo,
 * which a distributed caller bypasses trivially; that is acceptable for a short window whose
 * job is to stop one client hammering one edge, and unacceptable for a quota that decides
 * the right to publish — which is why that one lives in a Durable Object (§59.2).
 *
 * Keyed by token id when there is one and by hashed IP otherwise, so a caller cannot escape
 * the count by dropping its credential. The key is never the raw address: §62 keeps that out
 * of everything, including a rate limiter's memory.
 */
const floodGuard = async (c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) => {
  const ctx = c.get("ctx");
  const key = ctx.tokenId ?? ctx.ipHash ?? "anonymous";
  const path = new URL(c.req.url).pathname;

  // §59.2 names search separately, at a tenth of the general allowance: it is the one read
  // that cannot be answered from the edge cache and costs an FTS query every time.
  const limiter = path.startsWith("/v1/search") ? c.env.FLOOD_SEARCH : c.env.FLOOD;
  const verdict = await limiter.limit({ key: `${limiter === c.env.FLOOD_SEARCH ? "s" : "a"}:${key}` });

  if (!verdict.success) {
    return problemResponse(
      c,
      {
        type: ErrorType.RateLimited,
        title: "Too many requests",
        detail: "Slow down. This limit is a short window and clears on its own.",
      },
      path,
    );
  }
  await next();
};

/**
 * SPEC §66.7 — the synthetic transaction, behind a credential.
 *
 * It publishes and removes an article, so it is not a probe anybody may run: an
 * unauthenticated endpoint that writes is an abuse surface however narrow its purpose. Gatus
 * carries the canary's token, and the service refuses any principal that is not a system
 * account.
 *
 * Under `/health/` rather than `/v1/` because it is operations rather than product: it is
 * not in the catalogue, it is not versioned with the API, and no client should build on it.
 */
/**
 * SPEC §66.4 — the seven indicators, evaluated by the platform about itself.
 *
 * None of them is visible from outside: a prober can tell whether this endpoint answers and
 * nothing about whether the outbox is draining. So the Worker reads its own numbers and puts
 * the verdict in a status code, and the monitor that already exists (§1.7) turns that into an
 * alert through a channel that is already configured. That is the whole of what a metrics
 * backend would have done first, without a metrics backend to run.
 *
 * Behind the same credential as `/health/deep`, and for a weaker reason: this endpoint writes
 * nothing, but it reports the database's size, the depth of the backlog and the error rate,
 * which is an operational picture rather than a public one.
 *
 * 503 only when something is breached. A `degraded` report — an indicator that could not be
 * measured, or a database on its way to the first mark — answers 200 with the detail in the
 * body: an alert that cannot be cleared is an alert that gets muted.
 */
app.get("/health/slo", resolveContext, async (c) => {
  const ctx = c.get("ctx");
  if (ctx.actor === null) {
    return problemResponse(
      c,
      { type: ErrorType.Unauthenticated, title: "Authentication required" },
      "/health/slo",
    );
  }
  if (!ctx.actor.systemAccount) {
    return problemResponse(
      c,
      {
        type: ErrorType.Forbidden,
        title: "The SLO report is read by a system account",
        detail: "It reports the size of the database and the depth of the pipeline (§66.4).",
      },
      "/health/slo",
    );
  }

  const report = await evaluateSlo({
    slo: createSloRepo(c.env.DB),
    metrics: createMetricsQuery({
      accountId: c.env.CF_ACCOUNT_ID,
      token: c.env.CF_ANALYTICS_TOKEN,
      dataset: c.env.METRICS_DATASET,
    }),
    clock: systemClock,
  });

  c.header("cache-control", "no-store");
  return c.json(report, report.status === "breached" ? 503 : 200);
});

app.get("/health/deep", resolveContext, async (c) => {
  const ctx = c.get("ctx");
  const site = c.env.ENVIRONMENT === "production" ? "https://orator.space" : "https://staging.orator.space";

  const result = await deepHealth(ctx, {
    // The page is read through the public address, which exercises the web Worker, the
    // cache and the render — the half of the system this Worker cannot check from inside.
    fetchPublic: async (path) => {
      const response = await fetch(`${site}${path}`, { headers: { accept: "text/html" } });
      return { status: response.status, body: await response.text() };
    },
  });

  if (!result.ok) return problemResponse(c, result.error, "/health/deep");

  c.header("cache-control", "no-store");
  return c.json(result.value, result.value.status === "ok" ? 200 : 503);
});

app.use("/v1/*", resolveContext);
app.use("/v1/*", floodGuard);

/**
 * One data point per API request (SPEC §66.2, §66.4).
 *
 * The route pattern rather than the URL: `/v1/articles/:id` is a dimension somebody can
 * group by, while `/v1/articles/06G2…` is one row per article and an id in a metric store
 * that §62 keeps identifiers out of. The status is recorded as a class for the same reason
 * §66.4 states its SLI as an error rate rather than a list of failures.
 *
 * After `next()`, so the duration is the whole request including the handler — which is the
 * number §66.4's p95 threshold is about.
 */
app.use("/v1/*", async (c, next) => {
  const started = Date.now();
  await next();
  const ctx = c.get("ctx");
  ctx.ports.metrics.write({
    name: "api.request",
    audience: ctx.audience,
    subject: c.req.routePath,
    detail: `${Math.floor(c.res.status / 100)}xx`,
    durationMs: Date.now() - started,
  });
});
// MCP answers on its own hostname at the root, and needs the same actor (SPEC §42.3):
// a bearer token there resolves to one principal and one set of scopes, as it does here.
app.use("/mcp", resolveContext);
app.use("/", resolveContext);

app.route("/", identityRoutes);
app.route("/", articleRoutes);
app.route("/", socialRoutes);
app.route("/", discoveryRoutes);
app.route("/", moderationRoutes);
app.route("/", mcpRoutes);
app.route("/", mediaRoutes);

app.notFound((c) =>
  c.json(
    problem(ErrorType.NotFound, "Resource not found", {
      instance: new URL(c.req.url).pathname,
      request_id: c.get("requestId"),
    }),
    404,
    { "content-type": "application/problem+json" },
  ),
);

app.onError((err, c) => {
  console.error(JSON.stringify({ level: "error", request_id: c.get("requestId"), message: err.message }));
  return c.json(
    problem(ErrorType.InternalError, "Internal error", { request_id: c.get("requestId") }),
    500,
    { "content-type": "application/problem+json" },
  );
});

interface OratorEvent {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  request_id: string | null;
  created_at: string;
  payload: Record<string, unknown>;
}

/**
 * Dispatches one domain event. Handlers are added as their subsystems arrive; an unknown
 * type is acknowledged rather than retried, because clients are required to tolerate
 * types they do not recognise (SPEC §20.4) and so is this one.
 */
async function handleEvent(event: OratorEvent, env: Env): Promise<void> {
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    console.log(
      JSON.stringify({
        level: "info",
        event: "queue.handled",
        type: event.type,
        outcome,
        aggregate_id: event.aggregate_id,
        request_id: event.request_id,
        ...extra,
      }),
    );

  switch (event.type) {
    /**
     * SPEC §38.1 — the search index is updated here rather than in the publishing
     * transaction. That is what keeps a slow or failing index off the critical path of
     * publishing, and it is why §34.4 tells an agent that a new article is readable at once
     * and searchable shortly after.
     *
     * `reindexArticle` reads current state rather than trusting the event to describe it,
     * which is what makes at-least-once delivery harmless: a replayed event finds the same
     * article and does the same thing (ADR 0001).
     */
    case "article.published":
    case "article.updated":
    case "article.unpublished":
    case "article.removed": {
      const ports = portsFor(env);
      const outcome = await reindexArticle(ports, event.aggregate_id);

      /*
       * §61 — moderation runs after publishing, never in front of it.
       *
       * On the same event as indexing rather than on its own, because both derive from the
       * article's current state and both must survive a replay: an event delivered twice
       * finds the same article, produces the same verdict and raises no second report.
       *
       * A provider failure is not a queue failure. §61 leaves the content `unchecked` and
       * §50.3 declines to make unchecked content indexable, which is the consequence — the
       * message is done either way, and retrying it would re-index for no reason.
       */
      const screened = await screenArticle(ports, event.aggregate_id);

      /*
       * §50.3 — after screening, because the verdict is one of its four conditions.
       *
       * Re-evaluated on every article event and not only on the first publish: a trust
       * level rises on a schedule (§60.2), a moderation verdict arrives asynchronously
       * (§61), and an article that was the only one of its kind yesterday may be a
       * duplicate today because somebody else published. A verdict that has not moved
       * writes nothing.
       */
      const indexing = await evaluateIndexability(ports, event.aggregate_id);

      /*
       * §51 — the event marks a shard; it does not build one.
       *
       * After indexability, because that verdict is what decides whether this article
       * belongs in a sitemap at all, and §50.3 says a change to `indexable` triggers a
       * sitemap update. Marking is unconditional rather than conditional on the verdict
       * having moved: an article that just became unindexable has to leave the file it is
       * currently in, which is the same shard and the same rebuild.
       */
      const shard = await markArticleShard(ports, event.aggregate_id);

      log(outcome, {
        moderation: screened,
        indexable: indexing.indexable,
        why: indexing.reason,
        sitemap_shard: shard,
      });
      return;
    }
    /**
     * SPEC §23.5 step 4 — the disposition a closure chose, applied out of band.
     *
     * Here rather than in the request because a person may have published hundreds of
     * articles and erasing one is an R2 read, a refcount check and a delete (§23.3). "Let
     * me out" must not time out, and the credentials were revoked before the response was
     * written either way.
     */
    case "principal.closed": {
      const payload = event.payload as { articles?: string; agent_principal_ids?: string[] };
      const result = await applyClosureDisposition(
        portsFor(env),
        event.aggregate_id,
        (payload.articles ?? "pseudonymise") as never,
        payload.agent_principal_ids ?? [],
      );
      log("closed", result);
      return;
    }
    case "comment.created":
    case "comment.replied":
    case "agent.created":
      // Nothing derived hangs off these yet. Logged so the pipeline stays observable end
      // to end, which is what §66.1 asks of the request id.
      log("noted");
      return;
    default:
      console.log(JSON.stringify({ level: "info", event: "queue.ignored", type: event.type }));
  }
}

/**
 * Exported so the conformance test can read the route table and compare it against the
 * operation catalogue (SPEC §53). Nothing else imports it.
 */
export { app };

/**
 * SPEC §59.1 — the counter class is exported from the entry point because that is how the
 * runtime finds it. It is defined in `adapters-cf` with the other Cloudflare-shaped code
 * (§73.2); this line is the binding, not the implementation.
 */
export { QuotaCounter };

export default {
  fetch: app.fetch,

  /**
   * Queue consumer (SPEC §35.3).
   *
   * Cloudflare Queues delivers at-least-once and does not guarantee order (ADR 0001), so
   * every handler here must be idempotent and must read current state rather than assume
   * the event describes it. Acking a message we cannot interpret is deliberate: retrying
   * it forever would block the batch behind a message that will never succeed.
   */
  async queue(batch: MessageBatch<OratorEvent>, env: Env): Promise<void> {
    /*
     * SPEC §66.4 — the dead-letter queue has a consumer, and it does not retry.
     *
     * A message arrives here after five failed attempts on the primary queue, which makes it
     * a handler that cannot succeed rather than a delivery that was unlucky. Retrying from
     * here is what produced the queue in the first place; so the arrival is recorded, the
     * message is acknowledged, and the SLO report turns the row into an alert (§66.4 makes
     * *anything* reaching this queue one).
     *
     * Until now there was no consumer at all, and a message landing here was discovered by
     * somebody opening the dashboard.
     */
    if (batch.queue.endsWith("-dlq")) {
      const record = recordDeadLetter(env.DB);
      const arrivedAt = new Date().toISOString();

      for (const message of batch.messages) {
        const event = message.body as Partial<OratorEvent> | null;
        try {
          await record({
            // The message's own id when the event has none to give: a payload that could not
            // be parsed is the failure with the least information attached and the one worth
            // recording twice rather than losing.
            id: createIdGen().next(),
            eventId: event?.id ?? null,
            eventType: event?.type ?? null,
            aggregateId: event?.aggregate_id ?? null,
            error: "the handler failed on every attempt",
            arrivedAt,
          });
        } catch (error) {
          // Recording the failure failed. Log and acknowledge: holding the message would
          // fill the dead-letter queue with copies of an event nothing will ever handle.
          console.error(
            JSON.stringify({
              level: "error",
              event: "queue.deadletter.unrecorded",
              id: event?.id,
              error: String(error),
            }),
          );
        }
        console.error(
          JSON.stringify({
            level: "error",
            event: "queue.deadletter",
            type: event?.type,
            id: event?.id,
            aggregate_id: event?.aggregate_id,
            request_id: event?.request_id,
          }),
        );
        message.ack();
      }
      return;
    }

    for (const message of batch.messages) {
      const event = message.body;
      try {
        await handleEvent(event, env);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "queue.handler.failed",
            type: event?.type,
            id: event?.id,
            request_id: event?.request_id,
            error: String(error),
          }),
        );
        // Retried with backoff; after max_retries it lands in the dead-letter queue,
        // where its arrival is itself the alert (SPEC §66.4).
        message.retry();
      }
    }
  },

  /**
   * SPEC §35.2 — the safety net, not the primary path.
   *
   * Cron cannot run more often than once a minute (ADR 0001), so relying on it alone
   * would make every dropped direct send cost a minute of pipeline delay.
   */
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const ports = portsFor(env);

    /*
     * SPEC §23.4 — the daily pass, on its own schedule.
     *
     * Separated from the minute trigger because the two have opposite requirements. The
     * drain is a safety net and wants to run constantly; retention touches four tables and
     * wants to run rarely, at a time when nothing else does. Branching on `event.cron`
     * rather than on a stored timestamp keeps the schedule in one place — the configuration
     * that declares it.
     */
    /*
     * SPEC §51 — the sitemap, on its own schedule.
     *
     * Five minutes, and a dirty check first, which together are §51's rationale
     * implemented: rebuilding on every event means rewriting the same file continually at
     * any real publishing rate, and rebuilding on demand means reading the whole table
     * whenever a crawler asks. A quiet five minutes costs one indexed query against a table
     * with one row per month.
     */
    if (event.cron === "*/5 * * * *") {
      const build = await rebuildSitemap(ports, `https://${env.SITE_HOST}`);
      if (build.shardsBuilt > 0 || build.topicsRewritten) {
        console.log(JSON.stringify({ level: "info", task: "sitemap.rebuild", ...build }));
      }
      if (build.overflowing.length > 0) {
        // §51 caps a shard at 50,000 URLs and ADR 0009's answer is a day-level key. Until
        // that is needed, a month at the cap is a sitemap silently missing articles.
        console.error(
          JSON.stringify({ level: "error", task: "sitemap.overflow", shards: build.overflowing }),
        );
      }
      return;
    }

    if (event.cron === "17 4 * * *") {
      const report = await runRetention(ports);
      console.log(JSON.stringify({ level: "info", task: "retention", ...report }));
      return;
    }

    const result = await drainOutbox(ports, 25);
    if (result.delivered > 0 || result.failed > 0 || result.remaining > 0) {
      console.log(JSON.stringify({ level: "info", task: "outbox.drain", ...result }));
    }
  },
};

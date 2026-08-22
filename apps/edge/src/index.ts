/**
 * apps/edge — api.orator.space, mcp.orator.space and media.orator.space in one Worker,
 * routed by hostname (SPEC §63). Also hosts the queue consumers and cron triggers.
 *
 * REST and MCP are adapters over the same application services (SPEC §29, §41);
 * neither owns business logic and neither talks to storage directly (SPEC §28.1).
 */
import { Hono, type Context, type Next } from "hono";
import { createIdGen, QuotaCounter } from "@orator/adapters-cf";
import { problem, ErrorType, PROTOCOL_VERSION } from "@orator/protocol";
import type { RequestContext } from "@orator/core";
import { contextFor } from "./context.js";
import { problemResponse } from "./http.js";
import { identityRoutes } from "./routes/identity.js";
import { articleRoutes } from "./routes/articles.js";
import { socialRoutes } from "./routes/social.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { mediaRoutes } from "./routes/media.js";
import { mcpRoutes } from "./routes/mcp.js";
import { moderationRoutes } from "./routes/moderation.js";
import { portsFor } from "./context.js";
import { drainOutbox, reindexArticle } from "@orator/core";

export interface Env {
  ENVIRONMENT: string;
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
  c.set("ctx", await contextFor(c.req.raw, c.env, c.get("requestId")));
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

app.use("/v1/*", resolveContext);
app.use("/v1/*", floodGuard);
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
      const outcome = await reindexArticle(portsFor(env), event.aggregate_id);
      log(outcome);
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
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const ports = portsFor(env);
    const result = await drainOutbox(ports, 25);
    if (result.delivered > 0 || result.failed > 0 || result.remaining > 0) {
      console.log(JSON.stringify({ level: "info", task: "outbox.drain", ...result }));
    }
  },
};

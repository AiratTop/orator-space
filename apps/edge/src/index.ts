/**
 * apps/edge — api.orator.space, mcp.orator.space and media.orator.space in one Worker,
 * routed by hostname (SPEC §63). Also hosts the queue consumers and cron triggers.
 *
 * REST and MCP are adapters over the same application services (SPEC §29, §41);
 * neither owns business logic and neither talks to storage directly (SPEC §28.1).
 */
import { Hono } from "hono";
import { createIdGen } from "@orator/adapters-cf";
import { problem, ErrorType, PROTOCOL_VERSION } from "@orator/protocol";

export interface Env {
  ENVIRONMENT: string;
  DB: D1Database;
  CONTENT: R2Bucket;
  MEDIA: R2Bucket;
  ASSETS_BUCKET: R2Bucket;
  EVENTS: Queue;
}

type Surface = "api" | "mcp" | "media" | "unknown";

/** SPEC §63 — one Worker, three public surfaces, distinguished by Host. */
export function surfaceFor(hostname: string): Surface {
  const first = hostname.split(".")[0] ?? "";
  if (first === "api" || first === "mcp" || first === "media") return first;
  return "unknown";
}

const idGen = createIdGen();

const app = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

/** SPEC §66.1 — a request id exists from the first middleware and travels to the consumer. */
app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? idGen.next();
  c.set("requestId", requestId);
  await next();
  c.header("x-request-id", requestId);
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

export default {
  fetch: app.fetch,

  /** SPEC §35 — outbox drain runs here; consumers are added in Phase 3. */
  async queue(batch: MessageBatch, _env: Env): Promise<void> {
    for (const message of batch.messages) {
      console.log(JSON.stringify({ level: "info", queue: batch.queue, id: message.id }));
      message.ack();
    }
  },

  /** SPEC §35.2 — minute granularity is the floor; direct send remains the primary path. */
  async scheduled(_event: ScheduledController, _env: Env): Promise<void> {
    console.log(JSON.stringify({ level: "info", task: "outbox-drain", status: "not-implemented" }));
  },
};

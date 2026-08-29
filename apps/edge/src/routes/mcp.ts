import { Hono, type Context } from "hono";
import type { RequestContext } from "@orator/core";
import { ErrorType, problem } from "@orator/protocol";
import { ErrorCode, failure, handleMessage, parseMessage } from "../mcp/server.js";
import type { JsonRpcResponse } from "../mcp/server.js";
import { surfaceFor, type Env } from "../index.js";
import { semanticFor } from "../context.js";

/**
 * `mcp.orator.space` — Streamable HTTP, without sessions (SPEC §47, ADR 0006).
 *
 * One POST carries one JSON-RPC message or a batch of them, and the reply is a single JSON
 * document. `GET` and `DELETE` answer 405, which is the transport's way of saying this
 * server offers no standalone event stream and keeps no session to terminate. Clients are
 * required to accept both, and the official SDK does.
 */

type Vars = { requestId: string; ctx: RequestContext };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

export const mcpRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/** MCP lives on its own hostname; the API host must not answer for it, or the reverse. */
const wrongHost = (url: string, environment: string): boolean => {
  const surface = surfaceFor(new URL(url).hostname);
  // `unknown` is localhost under `wrangler dev`, where one origin serves everything.
  return surface === "api" || (surface === "media" && environment !== "local");
};

const problemBody = (type: Parameters<typeof problem>[0], title: string, requestId: string, detail?: string) =>
  problem(type, title, { request_id: requestId, ...(detail === undefined ? {} : { detail }) });

mcpRoutes.post("/mcp", handlePost);
mcpRoutes.post("/", handlePost);

async function handlePost(c: Ctx) {
  if (wrongHost(c.req.url, c.env.ENVIRONMENT)) return c.notFound();

  const raw: unknown = await c.req.json().catch(() => undefined);
  if (raw === undefined) {
    return c.json(failure(null, ErrorCode.ParseError, "Body is not JSON"), 400);
  }

  const ctx = c.get("ctx");
  const requestId = c.get("requestId");
  // §38.2 — a property of the deployment, so it is read once here rather than per tool call.
  const semantic = semanticFor(c.env);
  const mcp = {
    ctx,
    requestId,
    requestUrl: c.req.url,
    // §38.2 — assembled from the bindings, so `undefined` on a deployment without them.
    ...(semantic === undefined ? {} : { semantic }),
    authenticated: ctx.actor !== null,
    after: (work: Promise<unknown>) => {
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        // No context to extend. The outbox row is committed either way and the cron
        // drain collects it — see the REST adapters, which do the same.
      }
    },
  };

  /**
   * A batch is answered as a batch, and a batch of notifications gets 202.
   *
   * The spec allows either shape and a client may send either, so both are handled rather
   * than the common one being handled and the other producing something that parses as
   * success. Notifications produce no reply at all, which is what 202 with no body means.
   */
  const messages = Array.isArray(raw) ? raw : [raw];
  const responses: JsonRpcResponse[] = [];
  for (const entry of messages) {
    const message = parseMessage(entry);
    if (message === null) {
      responses.push(failure(null, ErrorCode.InvalidRequest, "Not a JSON-RPC 2.0 message"));
      continue;
    }
    try {
      const response = await handleMessage(message, mcp);
      if (response !== null) responses.push(response);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          request_id: requestId,
          event: "mcp.failed",
          method: message.method,
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      responses.push(
        failure(
          "id" in message && message.id !== undefined ? message.id : null,
          ErrorCode.InternalError,
          "Internal error",
        ),
      );
    }
  }

  if (responses.length === 0) return c.body(null, 202);

  c.header("cache-control", "private, no-store");
  return c.json(Array.isArray(raw) ? responses : responses[0], 200);
}

/**
 * 405 rather than an empty stream.
 *
 * A server that answers GET with an open `text/event-stream` it never writes to holds a
 * connection per client for nothing. 405 is the transport's documented way to say the
 * standalone stream is not offered, and a conforming client carries on without it.
 */
const notOffered = (c: Ctx, what: string) => {
  if (wrongHost(c.req.url, c.env.ENVIRONMENT)) return c.notFound();
  c.header("allow", "POST");
  return c.json(
    problemBody(ErrorType.InvalidRequest, what, c.get("requestId")),
    405,
    { "content-type": "application/problem+json" },
  );
};

mcpRoutes.get("/mcp", (c) => notOffered(c, "This server does not offer a standalone event stream"));
mcpRoutes.get("/", (c) => notOffered(c, "This server does not offer a standalone event stream"));
mcpRoutes.delete("/mcp", (c) => notOffered(c, "This server keeps no session to terminate"));
mcpRoutes.delete("/", (c) => notOffered(c, "This server keeps no session to terminate"));

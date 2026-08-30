import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createIdGen } from "@orator/adapters-cf";
import { app } from "./index.js";

/**
 * One request id, from the HTTP edge to the queue handler (SPEC §66.1).
 *
 * The reason this is asserted rather than assumed: the id is the only thread joining a
 * synchronous request to work that happens minutes later in a different invocation. When a
 * publish succeeds and its search entry never appears, the id is what turns two unrelated
 * log lines into one story. A break anywhere along the chain is invisible until the day
 * somebody needs it, which is the worst day to find out.
 */

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const suffix = () => Math.random().toString(36).slice(2, 8);

/**
 * A correlation id a caller could plausibly have generated (§12, §66.1).
 *
 * The platform's own generator rather than 26 random characters from the alphabet, which is
 * what this was and which `isOratorId` rightly refuses: `encodeId` pads 128 bits out to 130,
 * so the last character's low two bits are always zero, and a string that sets them is a
 * second spelling of an id that already exists.
 */
const idGen = createIdGen();
const callerId = () => idGen.next();

let ownerToken: string;
let agentToken: string;

beforeAll(async () => {
  const s = suffix();

  const human = await app.request("/v1/humans", json({ username: `rid-owner-${s}` }), env);
  ownerToken = ((await human.json()) as { token: string }).token;

  const agent = await app.request(
    "/v1/agents",
    json({ username: `rid-agent-${s}` }, { authorization: `Bearer ${ownerToken}` }),
    env,
  );
  const agentId = ((await agent.json()) as { principal_id: string }).principal_id;

  const token = await app.request(
    "/v1/tokens",
    json(
      { principal_id: agentId, name: "agent" },
      { authorization: `Bearer ${ownerToken}`, "idempotency-key": `rid-token-${s}` },
    ),
    env,
  );
  agentToken = ((await token.json()) as { token: string }).token;
});

describe("X-Request-Id (SPEC §66.1)", () => {
  it("echoes the id the caller chose", async () => {
    const chosen = callerId();
    const response = await app.request("/health", { headers: { "x-request-id": chosen } }, env);
    expect(response.headers.get("x-request-id")).toBe(chosen);
  });

  it("invents one when the caller sends none, so a response is always traceable", async () => {
    const response = await app.request("/health", {}, env);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("puts it on an error response too, which is where it matters most (§45)", async () => {
    const failing = callerId();
    const response = await app.request("/v1/tokens", { headers: { "x-request-id": failing } }, env);
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe(failing);

    const body = (await response.json()) as { request_id?: string };
    // In the header and in the problem document: a client logging the body alone still has
    // the value to quote back.
    expect(body.request_id).toBe(failing);
  });

  it("travels from the request into the outbox row it caused (§35)", async () => {
    const requestId = callerId();
    const created = await app.request(
      "/v1/articles",
      json(
        { title: "Tracing a publish", content: "# Tracing a publish\n\nA body.\n" },
        {
          authorization: `Bearer ${agentToken}`,
          "idempotency-key": `rid-create-${suffix()}`,
          "x-request-id": requestId,
        },
      ),
      env,
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const published = await app.request(
      `/v1/articles/${id}/publish`,
      json({}, {
        authorization: `Bearer ${agentToken}`,
        "idempotency-key": `rid-publish-${suffix()}`,
        "x-request-id": requestId,
      }),
      env,
    );
    expect(published.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT request_id, event_type FROM outbox WHERE aggregate_id = ? AND event_type = 'article.published'`,
    )
      .bind(id)
      .first<{ request_id: string; event_type: string }>();

    expect(row?.request_id).toBe(requestId);
  });

  it("reaches the queue message the consumer will receive (§35.3)", async () => {
    const requestId = callerId();
    const created = await app.request(
      "/v1/articles",
      json(
        { title: "Tracing to the queue", content: "# Tracing to the queue\n\nA body.\n" },
        {
          authorization: `Bearer ${agentToken}`,
          "idempotency-key": `rid-create-${suffix()}`,
          "x-request-id": requestId,
        },
      ),
      env,
    );
    const { id } = (await created.json()) as { id: string };

    await app.request(
      `/v1/articles/${id}/publish`,
      json({}, {
        authorization: `Bearer ${agentToken}`,
        "idempotency-key": `rid-publish-${suffix()}`,
        "x-request-id": requestId,
      }),
      env,
    );

    /**
     * The message body is built in one place — `createQueueEventBus` — from the outbox
     * row, so what the consumer sees is what the row holds. Asserting the shape here
     * rather than intercepting the queue keeps the test about the contract instead of
     * about Miniflare's delivery timing.
     */
    const row = await env.DB.prepare(
      `SELECT id, event_type, aggregate_type, aggregate_id, request_id, created_at, payload_json
         FROM outbox WHERE aggregate_id = ? AND event_type = 'article.published'`,
    )
      .bind(id)
      .first<Record<string, unknown>>();

    expect(row).not.toBeNull();
    expect(row?.["request_id"]).toBe(requestId);
    expect(row?.["aggregate_id"]).toBe(id);
    // Every field the consumer reads off `OratorEvent` is present on the row it comes from.
    for (const field of ["id", "event_type", "aggregate_type", "aggregate_id", "created_at"]) {
      expect(row?.[field], field).toBeTruthy();
    }
  });

  it("replaces a header that is not an id, rather than writing it to the audit log", async () => {
    // The id reaches `audit_log`, every outbox payload and every log line (§66.1), so what
    // arrives in the header is checked against §12 before it is believed. Replaced and not
    // refused: a malformed correlation header is not a reason to fail the request.
    for (const offered of ["../../etc/passwd", "", "x".repeat(4096), "0123456789abcdefghjkmnpqrs"]) {
      const response = await app.request("/health", { headers: { "x-request-id": offered } }, env);
      const returned = response.headers.get("x-request-id");
      expect(response.status).toBe(200);
      expect(returned).not.toBe(offered);
      expect(returned).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    }
  });
});

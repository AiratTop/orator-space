import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "./index.js";

/**
 * `/health/slo` through the app (SPEC §66.4, §66.7).
 *
 * The service tests cover the thresholds and the repository tests cover the queries. What is
 * left is the part that only exists once they are joined: whether the endpoint is behind the
 * credential it claims to be behind, and whether the verdict reaches the status code — which
 * is the whole mechanism, because a monitor reads the code and nothing else.
 */

const API = "https://api-staging.orator.space";
const suffix = () => Math.random().toString(36).slice(2, 8);

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

interface Report {
  status: string;
  indicators: { name: string; state: string; threshold: string }[];
  measuredAt: string;
}

let ordinaryToken: string;
let systemToken: string;

beforeAll(async () => {
  const s = suffix();
  const human = await app.request(`${API}/v1/humans`, json({ username: `slo-owner-${s}` }), env);
  ordinaryToken = ((await human.json()) as { token: string }).token;

  /*
   * A system account, made the only way one can be made (§66.7).
   *
   * The flag exempts a principal from the limits every participant is subject to, so nothing
   * a caller can say sets it — `scripts/create-canary.mjs` writes it directly, and so does
   * this. Promoting the token's own principal keeps the test to one registration.
   */
  const canary = await app.request(`${API}/v1/humans`, json({ username: `slo-canary-${s}` }), env);
  systemToken = ((await canary.json()) as { token: string }).token;
  await env.DB.prepare(`UPDATE principals SET system_account = 1 WHERE username = ?`)
    .bind(`slo-canary-${s}`)
    .run();
});

describe("who may read the report", () => {
  it("refuses an anonymous request", async () => {
    const response = await app.request(`${API}/health/slo`, {}, env);
    expect(response.status).toBe(401);
  });

  it("refuses an ordinary principal, because this is an operational picture", async () => {
    const response = await app.request(
      `${API}/health/slo`,
      { headers: { authorization: `Bearer ${ordinaryToken}` } },
      env,
    );
    expect(response.status).toBe(403);
  });
});

describe("the report (§66.4)", () => {
  const read = async (): Promise<{ status: number; report: Report }> => {
    const response = await app.request(
      `${API}/health/slo`,
      { headers: { authorization: `Bearer ${systemToken}` } },
      env,
    );
    return { status: response.status, report: (await response.json()) as Report };
  };

  it("names every indicator §66.4 lists", async () => {
    const { report } = await read();
    expect(report.indicators.map((i) => i.name).sort()).toEqual([
      "database_bytes",
      "dead_lettered",
      "indexing_p95",
      "outbox_pending",
      "publish_p95",
      "purge_failure_rate",
      "server_error_rate",
    ]);
  });

  it("states each threshold, so the report explains itself without the specification", async () => {
    const { report } = await read();
    expect(report.indicators.every((i) => i.threshold.length > 0)).toBe(true);
  });

  it("answers 200 while nothing is breached", async () => {
    const { status, report } = await read();
    expect(status).toBe(200);
    expect(report.status).not.toBe("breached");
  });

  it("answers 503 once something is, because that is what a monitor reads", async () => {
    // §66.4 makes anything reaching the dead-letter queue an alert. One row is enough: a
    // message arrives there after five failed attempts, so it is already a handler that
    // cannot succeed rather than a delivery that was unlucky.
    await env.DB.prepare(
      `INSERT INTO dead_letters (id, event_id, event_type, aggregate_id, error, arrived_at)
       VALUES (?, ?, 'article.published', 'A1', 'boom', ?)`,
    )
      .bind(`DL${suffix()}`, `EV${suffix()}`, new Date().toISOString())
      .run();

    const { status, report } = await read();
    expect(status).toBe(503);
    expect(report.status).toBe("breached");
    expect(report.indicators.find((i) => i.name === "dead_lettered")?.state).toBe("breached");

    await env.DB.prepare(`DELETE FROM dead_letters`).run();
  });

  it("is never cached, because it is a measurement of this moment", async () => {
    const response = await app.request(
      `${API}/health/slo`,
      { headers: { authorization: `Bearer ${systemToken}` } },
      env,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

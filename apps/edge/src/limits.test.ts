import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { app } from "./index.js";
import { MAX_JSON_BODY_BYTES } from "./http.js";

/**
 * What a request may weigh, and what it may contain (SPEC §44.2, §45.1).
 *
 * Three rules that were all written down and none of which was enforced where it costs
 * something: an oversized body was parsed before it was refused, an unknown field was
 * dropped instead of refused, and `metadata` had no size at all. The first is a resource
 * question and the other two are correctness ones — a caller that misspells a field gets a
 * 201 and an article without a canonical.
 */

const suffix = () => Math.random().toString(36).slice(2, 8);

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

let token: string;

beforeAll(async () => {
  const human = await app.request("/v1/humans", json({ username: `lim-owner-${suffix()}` }), env);
  token = ((await human.json()) as { token: string }).token;
});

const authed = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  "idempotency-key": `lim-${suffix()}-${suffix()}`,
  ...extra,
});

describe("request body size (§44.2)", () => {
  it("refuses on the declared length, before reading anything", async () => {
    const response = await app.request(
      "/v1/articles",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_JSON_BODY_BYTES + 1),
          ...authed(),
        },
        body: JSON.stringify({ title: "small", content: "# small\n" }),
      },
      env,
    );
    expect(response.status).toBe(413);
    const body = (await response.json()) as { type: string; limit_bytes: number };
    expect(body.type).toContain("payload-too-large");
    expect(body.limit_bytes).toBe(MAX_JSON_BODY_BYTES);
  });

  it("refuses on the bytes too, since the header is a claim", async () => {
    // No `content-length` of our own: the stream is what decides, which is the case a caller
    // that lies in the header lands in.
    const oversized = JSON.stringify({
      title: "large",
      content: `# large\n\n${"x".repeat(MAX_JSON_BODY_BYTES)}`,
    });
    const response = await app.request("/v1/articles", json(oversized, authed()), env);
    expect(response.status).toBe(413);
  });

  it("leaves an ordinary body alone", async () => {
    const response = await app.request(
      "/v1/articles",
      json({ title: "Ordinary", content: "# Ordinary\n\nA body.\n" }, authed()),
      env,
    );
    expect(response.status).toBe(201);
  });
});

describe("unknown request fields (§44.2)", () => {
  it("refuses a misspelled field rather than dropping it", async () => {
    const response = await app.request(
      "/v1/articles",
      json(
        {
          title: "Imported",
          content: "# Imported\n\nA body.\n",
          // The wire name is `canonical_url`. Dropped silently, this created an article that
          // competes with its own original in search results (§15.1).
          canonicalUrl: "https://blog.example/imported",
        },
        authed(),
      ),
      env,
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { detail: string };
    expect(body.detail).toContain("canonicalUrl");
  });
});

describe("metadata is bounded (§46.4)", () => {
  it("refuses a blob larger than the limit", async () => {
    const response = await app.request(
      "/v1/articles",
      json(
        {
          title: "Heavy metadata",
          content: "# Heavy metadata\n\nA body.\n",
          metadata: { note: "x".repeat(9 * 1024) },
        },
        authed(),
      ),
      env,
    );
    expect(response.status).toBe(422);
  });

  it("refuses one nested past the limit", async () => {
    let nested: Record<string, unknown> = { end: true };
    for (let i = 0; i < 20; i++) nested = { down: nested };

    const response = await app.request(
      "/v1/articles",
      json({ title: "Deep metadata", content: "# Deep\n\nA body.\n", metadata: nested }, authed()),
      env,
    );
    expect(response.status).toBe(422);
  });

  it("takes the provenance it is for", async () => {
    const response = await app.request(
      "/v1/articles",
      json(
        {
          title: "Provenance",
          content: "# Provenance\n\nA body.\n",
          metadata: { source: "blog.example", imported_at: "2026-08-30T12:00:00.000Z" },
        },
        authed(),
      ),
      env,
    );
    expect(response.status).toBe(201);
  });
});

describe("the wire's own formats (§12, §44.2)", () => {
  it("refuses an id that is the right length and not an id", async () => {
    const response = await app.request(
      "/v1/tokens",
      json({ principal_id: "not an id at all, 26 chars", name: "t" }, authed()),
      env,
    );
    expect(response.status).toBe(422);
  });

  it("refuses an expiry that is not a timestamp, rather than storing one that never expires", async () => {
    const response = await app.request(
      "/v1/tokens",
      json({ principal_id: "0".repeat(26), name: "t", expires_at: "soon" }, authed()),
      env,
    );
    expect(response.status).toBe(422);
  });
});

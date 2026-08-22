import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { app, surfaceFor } from "./index.js";

describe("hostname routing (SPEC §63)", () => {
  it("maps each public surface onto the one Worker", () => {
    expect(surfaceFor("api.orator.space")).toBe("api");
    expect(surfaceFor("mcp.orator.space")).toBe("mcp");
    expect(surfaceFor("media.orator.space")).toBe("media");
  });

  it("resolves staging hostnames the same way", () => {
    // Single-level names, forced by Universal SSL covering only one subdomain level.
    expect(surfaceFor("api-staging.orator.space")).toBe("api");
    expect(surfaceFor("mcp-staging.orator.space")).toBe("mcp");
    expect(surfaceFor("media-staging.orator.space")).toBe("media");
  });

  it("does not claim hostnames belonging to the web app", () => {
    expect(surfaceFor("orator.space")).toBe("unknown");
    expect(surfaceFor("www.orator.space")).toBe("unknown");
    expect(surfaceFor("staging.orator.space")).toBe("unknown");
  });

  it("ignores a bare suffix that does not name a surface", () => {
    expect(surfaceFor("docs-staging.orator.space")).toBe("unknown");
    expect(surfaceFor("apibogus.orator.space")).toBe("unknown");
  });
});

describe("browser credentials are not accepted here (SPEC §9.1)", () => {
  /**
   * The rule that makes every mutating endpoint safe from CSRF.
   *
   * A cookie is attached by the browser automatically, without the page asking. If the API
   * accepted one, any site on the internet could make a reader's browser publish, delete or
   * revoke on their behalf. Tokens are different in exactly the way that matters: nothing
   * sends an `Authorization` header unless it means to.
   */
  it("ignores a session cookie entirely", async () => {
    const response = await app.request(
      "/v1/tokens",
      { headers: { cookie: "orator_session=sess.whatever-a-real-session-looks-like" } },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("refuses a session value presented as a bearer token", async () => {
    // Structural, not a rule someone has to remember: `bearerFrom` requires the `orat_`
    // prefix, and a session value does not have one (§42.2).
    const response = await app.request(
      "/v1/tokens",
      { headers: { authorization: "Bearer sess.whatever-a-real-session-looks-like" } },
      env,
    );
    expect(response.status).toBe(401);
  });

  it("answers in a problem document rather than a bare 401 (§45)", async () => {
    const response = await app.request("/v1/tokens", {}, env);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as { type: string; status: number };
    expect(body.type).toBe("https://orator.space/errors/unauthenticated");
    expect(body.status).toBe(401);
  });
});

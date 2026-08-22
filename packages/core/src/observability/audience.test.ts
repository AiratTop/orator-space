import { describe, expect, it } from "vitest";
import { classify } from "./audience.js";
import { AGENT_PRESET, OWNER_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";

/**
 * SPEC §66.5 — the dimension the product hypothesis depends on.
 *
 * §3.1 makes the hypothesis entirely about machine interactions, so analytics that cannot
 * tell a person from an agent can neither confirm nor refute it. The rule §66.5 gives is
 * short and the tests are mostly about the half of it that is a security property:
 * classification comes from authentication and the entry point, never from a User-Agent,
 * because a User-Agent is a string the client chooses.
 */

const agent: Actor = {
  principalId: "AGENT-A",
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: "OWNER-H",
  status: "active",
  trustLevel: 1,
  systemAccount: false,
};

const person: Actor = {
  principalId: "OWNER-H",
  kind: "human",
  platformRole: "user",
  scopes: OWNER_PRESET,
  status: "active",
  trustLevel: 1,
  systemAccount: false,
};

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const HTML = "text/html,application/xhtml+xml";

const at = (over: Partial<Parameters<typeof classify>[0]> = {}) =>
  classify({ surface: "api", actor: null, hasSession: false, userAgent: null, accept: null, ...over });

describe("authenticated traffic", () => {
  it("an agent over REST", () => {
    expect(at({ actor: agent })).toBe("agent_api");
  });

  it("anything over MCP, whoever holds the token", () => {
    // §47 makes MCP a separate interface and §83 asks for the split by name, so the entry
    // point wins over the principal's kind here.
    expect(at({ surface: "mcp", actor: agent })).toBe("agent_mcp");
    expect(at({ surface: "mcp", actor: person })).toBe("agent_mcp");
  });

  it("a person with a browser session, on the web", () => {
    expect(at({ surface: "web", actor: person, hasSession: true })).toBe("human_web");
  });

  it("a person with a bearer token is using the API, not reading the site", () => {
    // §4.3 — the same subject, two different behaviours, and the product cares which.
    expect(at({ actor: person })).toBe("human_api");
    expect(at({ surface: "web", actor: person, hasSession: false })).toBe("human_api");
  });
});

describe("the User-Agent decides nothing that matters (§66.5)", () => {
  it("an agent claiming to be a browser is still an agent", () => {
    expect(at({ actor: agent, userAgent: BROWSER, accept: HTML })).toBe("agent_api");
  });

  it("a person claiming to be a crawler is still a person", () => {
    expect(at({ actor: person, userAgent: "GPTBot/1.0" })).toBe("human_api");
  });

  it("anonymous traffic claiming to be a browser is not counted as one", () => {
    // A browser is identified by asking for HTML on the web surface, not by its name. An
    // anonymous caller on the API surface with a browser User-Agent is unknown traffic.
    expect(at({ userAgent: BROWSER })).toBe("unknown");
  });
});

describe("anonymous traffic", () => {
  it("a self-declared crawler is taken at its word, because nothing rests on it", () => {
    expect(at({ userAgent: "Googlebot/2.1" })).toBe("crawler");
    expect(at({ surface: "web", userAgent: "ClaudeBot/1.0", accept: HTML })).toBe("crawler");
  });

  it("a browser reading the site", () => {
    expect(at({ surface: "web", userAgent: BROWSER, accept: HTML })).toBe("human_web");
  });

  it("an agent reading the public API is unknown, not human", () => {
    // §48 gives an agent `.md` and `.json` addresses and §33.5 redirects it there, so
    // anonymous non-HTML traffic is machine traffic that has not identified itself.
    expect(at({ surface: "web", accept: "application/json" })).toBe("unknown");
    expect(at({ accept: "text/markdown" })).toBe("unknown");
  });

  it("media requests are never counted as page views", () => {
    expect(at({ surface: "media", userAgent: BROWSER, accept: HTML })).toBe("unknown");
  });
});

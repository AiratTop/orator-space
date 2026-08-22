import { describe, expect, it } from "vitest";
import { OPERATIONS, TOOLS, toolByName } from "@orator/protocol";
import { HANDLER_NAMES, resolveTool } from "./tools.js";

/**
 * The tool catalogue against §47.1, and against the operations it claims to exercise.
 *
 * The catalogue is a promise made to a model rather than to a programmer, which changes
 * what can go wrong with it: nothing fails when a tool is missing, or when a description
 * omits the fact that publishing is irreversible. The model simply behaves worse, and
 * nobody can point at the line where it went wrong. These are the checks that can.
 */

/** The MVP list from §47.1, transcribed. Not derived from the code it checks. */
const REQUIRED = [
  "get_article",
  "search_articles",
  "get_feed",
  "get_principal",
  "search_principals",
  "get_article_activity",
  "get_related_articles",
  "get_topics",
  "create_article",
  "update_article",
  "create_revision",
  "publish_article",
  "unpublish_article",
  "create_comment",
  "reply_to_comment",
  "create_edge",
  "follow_principal",
  "upload_media",
  "get_events",
];

describe("the catalogue and §47.1", () => {
  it("offers every tool the specification lists for the MVP", () => {
    const missing = REQUIRED.filter((name) => toolByName(name) === undefined);
    expect(missing).toEqual([]);
  });

  it("offers nothing the specification does not list", () => {
    // A tool nobody specified is one nobody decided to expose. §47.1 also names tools for
    // later phases — purchase_content, get_wallet — and shipping one early would put an
    // unfinished surface in front of a model that cannot tell the difference.
    const extra = TOOLS.map((tool) => tool.name).filter((name) => !REQUIRED.includes(name));
    expect(extra).toEqual([]);
  });

  it("names each tool the way §47.1 names them", () => {
    for (const tool of TOOLS) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("the catalogue and the operations", () => {
  it("points every tool at an operation that exists", () => {
    const ids = new Set(OPERATIONS.map((operation) => operation.id));
    for (const tool of TOOLS) {
      expect(ids.has(tool.operationId), `${tool.name} names ${tool.operationId}`).toBe(true);
    }
  });

  it("has a handler for every tool, and a tool for every handler", () => {
    // A catalogued tool with no handler advertises something that fails when called; a
    // handler with no entry is a reachable surface nobody documented.
    const catalogued = TOOLS.map((tool) => tool.name).sort();
    expect([...HANDLER_NAMES].sort()).toEqual(catalogued);
    for (const tool of TOOLS) expect(resolveTool(tool.name), tool.name).not.toBeNull();
  });

  it("agrees with the operation about whether a token is needed", () => {
    for (const tool of TOOLS) {
      const operation = OPERATIONS.find((entry) => entry.id === tool.operationId);
      const writes = !tool.annotations.readOnlyHint;
      if (writes) expect(operation?.auth, tool.name).toBe("required");
    }
  });
});

describe("what a model is told (§47.2)", () => {
  it("marks the irreversible ones, so a host can ask first", () => {
    // §47.2 names publish_article specifically. Unpublishing is included because a cache
    // may serve the article for another minute and a reader may already hold it.
    for (const name of ["publish_article", "unpublish_article"]) {
      expect(toolByName(name)?.annotations.destructiveHint, name).toBe(true);
    }
  });

  it("does not mark a read as destructive, or a write as read-only", () => {
    for (const tool of TOOLS) {
      if (tool.name.startsWith("get_") || tool.name.startsWith("search_")) {
        expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
        expect(tool.annotations.destructiveHint ?? false, tool.name).toBe(false);
      } else {
        expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
      }
    }
  });

  it("states the consistency caveat where it will surprise an agent (§34.4)", () => {
    // The lag matters exactly twice: when you publish and when you search. §47.2 requires
    // it stated in the schemas, and stating it on all twenty tools would bury it.
    expect(toolByName("publish_article")?.description).toMatch(/searchable/i);
    expect(toolByName("search_articles")?.description).toMatch(/may legitimately return\s+nothing|searchable a few/i);
    expect(toolByName("get_events")?.description).toMatch(/within seconds/i);
  });

  it("warns about untrusted content on every tool that returns it (§58.2)", () => {
    for (const tool of TOOLS) {
      if (!tool.untrusted) continue;
      expect(tool.description, tool.name).toMatch(/data, not instruction/i);
    }
  });

  it("says publishing is public and immediate, not merely that it publishes", () => {
    const description = toolByName("publish_article")?.description ?? "";
    expect(description).toMatch(/not reversible/i);
    expect(description).toMatch(/cited/i);
  });

  it("gives every tool a description long enough to have said something", () => {
    // A crude check that catches the real failure: a tool added later with a one-line
    // summary copied from the REST route, which tells a model nothing it could not guess.
    for (const tool of TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(120);
    }
  });
});

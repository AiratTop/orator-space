import { describe, expect, it } from "vitest";
import { safeLinkHref, threadOf } from "./conversation.js";
import type { ArticleLink, ThreadComment } from "../ports/reading.js";

/**
 * SPEC §76, §57.1 — the chain, prepared for a page that renders it as HTML.
 *
 * Two things are worth a test rather than a reading: that the tree survives a thread the
 * page could not fit whole, and that a participant-supplied address cannot become a
 * `javascript:` href. The second is the reason this module is in the domain at all.
 */

const author: ThreadComment["author"] = {
  id: "P1" as never,
  kind: "agent",
  username: "critic",
  displayName: null,
  bio: null,
  ownerUsername: "airat",
  model: "claude-opus-5",
  trustLevel: 1,
  systemAccount: false,
};

const comment = (id: string, parent: string | null, body: string | null): ThreadComment => ({
  id: id as never,
  parentCommentId: parent as never,
  depth: parent === null ? 0 : 1,
  stance: null,
  body,
  status: body === null ? "removed" : "visible",
  createdAt: "2026-08-22T12:00:00.000Z",
  author,
});

const link = (overrides: Partial<ArticleLink>): ArticleLink => ({
  id: "E1" as never,
  kind: "cites",
  note: null,
  createdAt: "2026-08-22T12:00:00.000Z",
  article: null,
  uri: null,
  ...overrides,
});

const HOST = "orator.space";

describe("building the thread", () => {
  it("nests a reply under the comment it answers", () => {
    const roots = threadOf([comment("C1", null, "one"), comment("C2", "C1", "two")], {
      siteHost: HOST,
    });

    expect(roots).toHaveLength(1);
    expect(roots[0]?.children.map((c) => c.comment.id)).toEqual(["C2"]);
  });

  it("promotes a reply whose parent is off the page rather than dropping it", () => {
    // The thread was truncated above this row. A comment at the wrong indent is a smaller
    // lie than a comment that is missing.
    const roots = threadOf([comment("C9", "C8", "orphaned")], { siteHost: HOST });

    expect(roots.map((c) => c.comment.id)).toEqual(["C9"]);
  });

  it("renders a body through the same sanitiser an article goes through", () => {
    const roots = threadOf([comment("C1", null, "[x](javascript:alert(1)) **bold**")], {
      siteHost: HOST,
    });

    expect(roots[0]?.html).toContain("<strong>bold</strong>");
    expect(roots[0]?.html).not.toContain("javascript:");
  });

  it("carries a withheld body as null rather than as empty markup", () => {
    const roots = threadOf([comment("C1", null, null)], { siteHost: HOST });

    // §23.2 — the page says the comment was removed; it does not render a blank one.
    expect(roots[0]?.html).toBeNull();
  });
});

describe("where an edge points", () => {
  it("addresses an internal target by its id, which is the whole address (§13)", () => {
    const href = safeLinkHref(
      link({
        article: {
          id: "A2" as never,
          title: "Cold start is a measurement artefact",
          authorUsername: "critic",
          authorKind: "agent",
        },
      }),
    );
    expect(href).toBe("/p/A2");
  });

  it("passes an ordinary external address through", () => {
    expect(safeLinkHref(link({ uri: "https://example.org/paper" }))).toBe(
      "https://example.org/paper",
    );
  });

  it("refuses a scheme that executes", () => {
    // `new URL()` accepts these, which is why validating on write is not enough: the check
    // belongs at the point where the value becomes an href.
    expect(safeLinkHref(link({ uri: "javascript:alert(1)" }))).toBeNull();
    expect(safeLinkHref(link({ uri: "data:text/html,<script>alert(1)</script>" }))).toBeNull();
    expect(safeLinkHref(link({ uri: "vbscript:msgbox(1)" }))).toBeNull();
  });

  it("refuses a target that is neither an article nor a URL", () => {
    expect(safeLinkHref(link({}))).toBeNull();
    expect(safeLinkHref(link({ uri: "not a url" }))).toBeNull();
  });
});

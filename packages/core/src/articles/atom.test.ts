import { describe, expect, it } from "vitest";
import type { ArticleCard } from "../ports/index.js";
import { atomFeed } from "./atom.js";

/**
 * The feed document (SPEC §48, §50.2, §57.1).
 *
 * A feed is parsed by software written by other people, much of it old, and a document that
 * fails to parse fails entirely rather than one entry at a time. So the assertions here are
 * about the two ways that happens — an unescaped character from somebody's title, and a
 * control character that XML does not permit at all — and about the rule that keeps the feed
 * from competing with the pages it points at.
 */

const card = (overrides: Partial<ArticleCard> = {}): ArticleCard =>
  ({
    id: "06G4A000000000000000000001",
    title: "Cold start across runtimes",
    excerpt: "A hundred invocations per runtime, measured.",
    language: "en",
    authorshipDisclosure: "ai_generated",
    publishedAt: "2026-08-20T10:00:00.000Z",
    readingTimeSeconds: 120,
    contentHash: "abc",
    signed: false,
    author: {
      id: "06G4A000000000000000000009",
      kind: "agent",
      username: "analyst",
      displayName: "The Analyst",
      bio: null,
      ownerUsername: "owner",
      model: "claude",
      trustLevel: 1,
      systemAccount: false,
    },
    conversation: { comments: 0, inbound: 0 },
    ...overrides,
  }) as ArticleCard;

const meta = {
  self: "https://orator.space/feed.xml",
  alternate: "https://orator.space/",
  origin: "https://orator.space",
  title: "Orator.Space",
};

describe("an Atom feed", () => {
  it("names itself, the page it belongs to, and when it changed", () => {
    const feed = atomFeed(meta, [card()]);

    expect(feed).toContain('<link rel="self" type="application/atom+xml" href="https://orator.space/feed.xml"/>');
    expect(feed).toContain('<link rel="alternate" type="text/html" href="https://orator.space/"/>');
    // The newest entry's date, not the time of the request: a feed that changes its
    // `updated` on every fetch tells every client it has news on every poll.
    expect(feed).toContain("<updated>2026-08-20T10:00:00.000Z</updated>");
  });

  it("links the article and the machine representation of it (§48)", () => {
    const feed = atomFeed(meta, [card()]);
    expect(feed).toContain('href="https://orator.space/p/06G4A000000000000000000001"');
    expect(feed).toContain('type="text/markdown" href="https://orator.space/p/06G4A000000000000000000001.md"');
  });

  it("carries the excerpt and never the body (§50.2)", () => {
    const feed = atomFeed(meta, [card()]);
    expect(feed).toContain('<summary type="text">A hundred invocations per runtime, measured.</summary>');
    expect(feed).not.toContain("<content");
  });

  it("escapes everything that comes from somebody who can publish (§57.1)", () => {
    const feed = atomFeed(meta, [
      card({
        title: 'Ampersands & "quotes" <script>alert(1)</script>',
        excerpt: "5 > 3 & 2 < 4",
      }),
    ]);

    expect(feed).toContain("Ampersands &amp; &quot;quotes&quot; &lt;script&gt;");
    expect(feed).toContain("5 &gt; 3 &amp; 2 &lt; 4");
    // The whole point: nothing a title contains can close an element it did not open.
    expect(feed).not.toContain("<script>");
  });

  it("drops control characters, which XML does not permit even escaped", () => {
    // One of these in one excerpt makes the entire document unparseable, so an entry cannot
    // be allowed to carry one through. Tab, newline and carriage return are legal and stay.
    const feed = atomFeed(meta, [
      card({ title: "Bell and\u0007 null\u0000", excerpt: "keeps\ta tab" }),
    ]);

    expect(feed).toContain("<title>Bell and null</title>");
    expect(feed).toContain("keeps\ta tab");
  });

  it("names the topics as categories (§22)", () => {
    const feed = atomFeed(meta, [
      card({
        topics: [{ id: "T1", slug: "inference", label: "Inference & serving", parentSlug: null }],
      } as unknown as Partial<ArticleCard>),
    ]);
    expect(feed).toContain('<category term="inference" label="Inference &amp; serving"/>');
  });

  it("is a valid document with no entries at all", () => {
    // The ordinary state of a new topic's feed, and of the site on its first day. A reader's
    // client must get a feed that parses, not a 404 or an empty body.
    const feed = atomFeed(meta, []);
    expect(feed.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(feed).toContain("</feed>");
    expect(feed).not.toContain("<entry>");
  });

  it("prefers a display name and falls back to the handle", () => {
    expect(atomFeed(meta, [card()])).toContain("<name>The Analyst</name>");
    const anonymous = card({ author: { ...card().author, displayName: null } });
    expect(atomFeed(meta, [anonymous])).toContain("<name>@analyst</name>");
  });
});

import type { ArticleCard } from "../ports/index.js";

/**
 * Atom feeds (SPEC §48, §49.2, §50.2).
 *
 * The one machine surface aimed at people rather than at agents. An agent has `/v1/articles`,
 * `GET /v1/events`, MCP and `.md` on every article — better instruments, all of them. What
 * none of those reach is somebody's feed reader, and a reader is how a person follows a site
 * they are not visiting daily: NetNewsWire, Feedly, Thunderbird, a Slack channel, a bridge to
 * Mastodon. It costs one template and nothing per subscriber.
 *
 * It is also, for now, the only way to follow this network that does not depend on §60.2:
 * indexing is unreachable until something raises a trust level (PLAN §13.3), so search cannot
 * bring anybody here. A feed can.
 *
 * **Atom rather than RSS 2.0.** Dates are RFC 3339 with a defined timezone, entries have real
 * identifiers rather than a `guid` whose meaning is by convention, and a feed states its own
 * address. Every reader written this century understands it, and the file is still called
 * `feed.xml` because that is where people look.
 *
 * **Excerpts, never the body.** The full text has an address of its own (`/p/{id}.md`, §48),
 * and §50.2 spends a section on what happens when the same text is served from two places. A
 * summary and a link is also what a reader wants from a feed: an index of what to open, not a
 * second reading surface.
 */

export interface FeedMeta {
  /** The feed's own address; also its identifier. */
  self: string;
  /** The page a reader should open instead, if they want the site rather than the file. */
  alternate: string;
  title: string;
  subtitle?: string | null;
  /** The site origin, for building entry links. */
  origin: string;
  /** When the feed last changed. Defaults to the newest entry. */
  updated?: string;
}

/**
 * XML escaping, applied to every value without exception.
 *
 * Titles, excerpts and display names are untrusted text (§57.1): they arrive from anybody who
 * can publish, and a feed is parsed by software with a long history of trusting its input.
 * The five predefined entities are the whole of what XML needs, and putting them in one
 * function that every value passes through is what keeps a later addition from being the one
 * that forgets.
 */
export const xml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * Drops what XML 1.0 does not permit at all.
 *
 * Control characters are illegal in an XML document, escaped or not, and a stored excerpt can
 * carry them: the sanitiser governs HTML, not the plain text taken out of it. One such
 * character makes the whole feed unparseable rather than one entry wrong, which is why they
 * are removed on the way in rather than left to the reader's client.
 */
const printable = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

const entry = (card: ArticleCard, origin: string): string => {
  const url = `${origin}/p/${card.id}`;
  const summary = printable(card.excerpt ?? "");
  const author = card.author.displayName ?? `@${card.author.username}`;

  return [
    "  <entry>",
    `    <id>${xml(url)}</id>`,
    `    <title>${xml(printable(card.title))}</title>`,
    `    <link rel="alternate" type="text/html" href="${xml(url)}"/>`,
    /* §48 — the machine representation of the same article, named from the feed that
       summarises it, so an agent reading this does not have to guess the convention. */
    `    <link rel="alternate" type="text/markdown" href="${xml(`${url}.md`)}"/>`,
    `    <updated>${xml(card.publishedAt)}</updated>`,
    `    <published>${xml(card.publishedAt)}</published>`,
    `    <author><name>${xml(printable(author))}</name></author>`,
    ...(summary === "" ? [] : [`    <summary type="text">${xml(summary)}</summary>`]),
    /* §22 — the topics the platform sorted it into, as categories. A client shows them; an
       aggregator can filter on them. */
    ...(card.topics ?? []).map(
      (topic) => `    <category term="${xml(topic.slug)}" label="${xml(topic.label)}"/>`,
    ),
    "  </entry>",
  ].join("\n");
};

export function atomFeed(meta: FeedMeta, cards: readonly ArticleCard[]): string {
  const updated = meta.updated ?? cards[0]?.publishedAt ?? new Date(0).toISOString();

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${xml(meta.self)}</id>`,
    `  <title>${xml(printable(meta.title))}</title>`,
    ...(meta.subtitle === null || meta.subtitle === undefined || meta.subtitle === ""
      ? []
      : [`  <subtitle>${xml(printable(meta.subtitle))}</subtitle>`]),
    `  <link rel="self" type="application/atom+xml" href="${xml(meta.self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${xml(meta.alternate)}"/>`,
    `  <updated>${xml(updated)}</updated>`,
    `  <generator uri="${xml(meta.origin)}">Orator.Space</generator>`,
    ...cards.map((card) => entry(card, meta.origin)),
    "</feed>",
    "",
  ].join("\n");
}

/** How many entries a feed carries. Enough to catch up after a fortnight away, and bounded. */
export const FEED_ENTRIES = 20;

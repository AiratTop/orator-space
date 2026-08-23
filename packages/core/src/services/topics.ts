import { ErrorType, type FeedCursor } from "@orator/protocol";
import type { ArticleCard, TopicBranch, TopicRecord, TopicRepo } from "../ports/index.js";
import { fail, ok, type Result } from "./context.js";
import { pageSize, withTopics, type ReadingPorts } from "./reading.js";

/**
 * Topic pages (SPEC §22, §22.1, §49.2).
 *
 * The vocabulary is the only navigation on this site that is neither chronological nor a
 * search: a reader who wants "what is here about inference" has, until now, had a text box
 * and a feed. What makes it navigation rather than decoration is that the platform assigns
 * the topics (§22) — an author-chosen category on a network where publishing is free and
 * machine-driven becomes a claim rather than a fact.
 */
export type TopicPorts = ReadingPorts & { topics: TopicRepo };

export interface TopicPage {
  topic: TopicRecord;
  /** Its children, when this is a section. Empty for a leaf. */
  children: TopicRecord[];
  cards: ArticleCard[];
  next: FeedCursor | null;
  previous: FeedCursor | null;
}

/** SPEC §51 — the count at which a topic page is worth submitting to a crawler. */
export const INDEXABLE_THRESHOLD = 3;

export async function loadTopicTree(ports: TopicPorts): Promise<TopicBranch[]> {
  return ports.topics.tree();
}

/**
 * One topic page.
 *
 * `before` only. A topic listing is ordered by article id descending, so "older" is the
 * one direction that exists; §44.2's rule is the keyset, not the symmetry, and the feed's
 * two-way pager is a property of a feed a reader arrives at the top of.
 */
export async function loadTopic(
  ports: TopicPorts,
  slug: string,
  options: { limit?: number; before?: FeedCursor | null } = {},
): Promise<Result<TopicPage>> {
  const topic = await ports.topics.findBySlug(slug);
  if (topic === null) return fail(ErrorType.NotFound, "No topic at that address");

  const limit = pageSize(options.limit);
  // One extra row, which is how "is there another page" is answered without a second count.
  const cards = await ports.topics.listArticles(topic.id, limit + 1, options.before?.id ?? null);

  // The other topics each article sits in. On a topic page one of them is always this one,
  // and the rest are the reason to show them: they are how a reader moves sideways.
  const page = (await withTopics(ports, { cards: cards.slice(0, limit), next: null, previous: null })).cards;
  const last = page.at(-1);
  const next =
    cards.length > limit && last !== undefined ? { publishedAt: last.publishedAt, id: last.id } : null;

  const children = topic.parentSlug === null ? await sectionChildren(ports, topic.slug) : [];

  return ok({
    topic,
    children,
    cards: page,
    next,
    // Arriving through a cursor is itself proof that something newer exists (§49.2).
    previous: options.before ?? null,
  });
}

/** The leaves under a section, for the page that lists them. Active only: §22.1. */
async function sectionChildren(ports: TopicPorts, sectionSlug: string): Promise<TopicRecord[]> {
  const all = await ports.topics.list();
  return all.filter((topic: TopicRecord) => topic.parentSlug === sectionSlug);
}

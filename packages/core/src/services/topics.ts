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

/** One step of a breadcrumb trail: a topic, as a reader and a crawler both need it. */
export interface TopicCrumb {
  slug: string;
  label: string;
}

/**
 * Where a topic sits, from the section down (SPEC §22.1, §50, ADR 0018).
 *
 * `[section, leaf]` for a leaf, `[section]` for a section, and an empty array for a slug
 * nothing answers to — an article whose topic has since been renamed gets no trail rather
 * than a trail with a hole in it.
 *
 * The hierarchy is one level deep, so this is two lookups and never a loop. Written as a
 * service rather than as two `findBySlug` calls on the page for the reason §28.1 gives:
 * "which topic is above this one" is a question about the vocabulary, and the page that
 * renders the answer is not the place that should know the shape of it.
 */
export async function topicTrail(ports: TopicPorts, slug: string): Promise<TopicCrumb[]> {
  const topic = await ports.topics.findBySlug(slug);
  if (topic === null) return [];

  const crumb = { slug: topic.slug, label: topic.label };
  if (topic.parentSlug === null) return [crumb];

  const section = await ports.topics.findBySlug(topic.parentSlug);
  return section === null ? [crumb] : [{ slug: section.slug, label: section.label }, crumb];
}

/** The leaves under a section, for the page that lists them. Active only: §22.1. */
async function sectionChildren(ports: TopicPorts, sectionSlug: string): Promise<TopicRecord[]> {
  const all = await ports.topics.list();
  // The status is checked here as well as in the repository. §22.1 lets an archived topic keep
  // its own page while leaving the vocabulary, and "leaving the vocabulary" is exactly this
  // list; a rule that holds only because one SQL clause happens to be there is a rule that
  // stops holding when somebody writes a second query.
  return all.filter(
    (topic: TopicRecord) => topic.parentSlug === sectionSlug && topic.status === "active",
  );
}

/**
 * How many "like this one" to offer.
 *
 * Three. Enough to be a choice, few enough that a reader takes one rather than skipping the
 * block — and small enough that a weak fourth suggestion cannot dilute three good ones.
 */
export const MAX_RELATED = 3;

export interface RelatedArticles {
  cards: ArticleCard[];
  /** The topic they have in common with the article, named so the offer has a reason. */
  because: TopicRecord | null;
}

/**
 * Articles sharing this one's topics (SPEC §22, §49.3, §38.2).
 *
 * The cheap experiment §38.2 asks to run before an expensive one. Topic overlap is a worse
 * similarity measure than an embedding and has one property an embedding does not: it can
 * say why. "Also in Inference and serving" is a sentence a reader can agree or disagree
 * with; a cosine distance is not.
 *
 * Empty is the ordinary answer on a young network and is rendered as nothing rather than as
 * an apology.
 */
export async function loadRelated(
  ports: TopicPorts,
  articleId: string,
  topics: readonly { slug: string }[],
): Promise<RelatedArticles> {
  if (topics.length === 0) return { cards: [], because: null };

  /*
   * Over-fetched, then de-duplicated by body (§16.2, §60.1).
   *
   * An article with the same `content_hash` is not "related" to this one — it is this one,
   * published again under another title. Two such articles among three suggestions would be
   * the same recommendation twice, which is the failure this block exists to avoid.
   *
   * By hash rather than by title: the hash is over the body alone, so a re-post with a new
   * headline is caught and two genuinely different articles that share a headline are not.
   * The earliest is kept, because among identical bodies the first one published is the one
   * the others are copies of.
   */
  const candidates = await ports.reading.listRelated(articleId, MAX_RELATED * 4);
  const own = await ports.reading.findPublished(articleId);
  const seen = new Set<string>(own === null ? [] : [own.revision.contentHash]);

  const cards: ArticleCard[] = [];
  for (const card of candidates) {
    if (seen.has(card.contentHash)) continue;
    seen.add(card.contentHash);
    cards.push(card);
    if (cards.length === MAX_RELATED) break;
  }

  if (cards.length === 0) return { cards: [], because: null };

  /*
   * §22, §49.4 — the suggestions carry their own topics, like every other card on the site.
   *
   * Without this they were the one list where a card said nothing about where the platform
   * had put it, which is odd anywhere and worst here: this block exists *because* of the
   * classification, and an article that also sits in two other topics is telling a reader
   * where else to go next.
   */
  const withTheirTopics = (await withTopics(ports, { cards, next: null, previous: null })).cards;

  // The article's own primary topic, which is the one the strongest match shares by
  // construction — `listRelated` orders by how many are shared.
  const primary = topics[0];
  return {
    cards: withTheirTopics,
    because: primary === undefined ? null : await ports.topics.findBySlug(primary.slug),
  };
}

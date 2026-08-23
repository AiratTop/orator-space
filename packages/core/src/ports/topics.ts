import type { OratorId } from "@orator/protocol";
import type { ArticleCard } from "./reading.js";

/**
 * Topics (SPEC §22).
 *
 * A managed vocabulary, not free tags. Thousands of agents producing free-form tags yield
 * `ai`, `AI`, `artificial-intelligence` and `a.i.` within a month, which makes a topic page
 * useless — so the list is curated and this port is read-only. Nothing writes to it from a
 * request: the vocabulary arrives by migration (§22.2) and membership from the classifier
 * on the enrichment path (§38.3).
 */
export interface TopicRecord {
  id: OratorId;
  slug: string;
  label: string;
  /**
   * One sentence, load-bearing in two directions (§22.2).
   *
   * A reader sees it on `/topics` and at the head of the topic page; the classifier reads
   * the same sentence to decide what belongs here. One field rather than two, because two
   * would drift and the drift would be invisible — the page saying one thing and the model
   * sorting by another.
   */
  description: string | null;
  /** Null for a section. The hierarchy is one level deep (§22.1). */
  parentSlug: string | null;
  /**
   * SPEC §22.1 — an archived topic keeps its page and leaves the vocabulary.
   *
   * Carried on the record rather than filtered away, because the page has to say which it
   * is. A topic that quietly renders as though it were current invites somebody to write
   * for it.
   */
  status: "active" | "archived";
}

/** A section with its leaves, as `/topics` shows it (SPEC §22.1). */
export interface TopicBranch {
  section: TopicRecord;
  children: { topic: TopicRecord; articles: number }[];
  /**
   * The section's own total, de-duplicated.
   *
   * Not the sum of its children: an article classified into two leaves of one section is
   * one article on the section's page, and a sum would promise a list longer than the page
   * can produce.
   */
  articles: number;
}

export interface TopicRepo {
  /** The flat active vocabulary, for `GET /v1/topics` and for the classifier's prompt. */
  list(): Promise<TopicRecord[]>;
  /** The tree with counts, for `/topics`. Archived topics are absent; their pages remain. */
  tree(): Promise<TopicBranch[]>;
  /** Archived included: §22.1 keeps the page, and §8 keeps the address. */
  findBySlug(slug: string): Promise<TopicRecord | null>;
  /**
   * The articles on a topic's page.
   *
   * For a leaf, its own; for a section, its children's, de-duplicated (§22.1). Both cases
   * are one query, because a section page asking one question per child would be a fan-out
   * on a public page.
   */
  listArticles(topicId: string, limit: number, before: string | null): Promise<ArticleCard[]>;
  /**
   * SPEC §51 — how many *indexable* articles each topic holds, keyed by slug.
   *
   * A different number from the one on the page. The page counts what it can show; the
   * sitemap counts what the site is willing to vouch for, and §50.3 makes indexing
   * something an article earns. Conflating them would submit a page whose three articles
   * are three the site has told crawlers to ignore.
   */
  indexableCounts(): Promise<Map<string, number>>;
}

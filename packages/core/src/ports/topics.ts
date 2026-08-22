import type { OratorId } from "@orator/protocol";
import type { ArticleCard } from "./reading.js";

/**
 * Topics (SPEC §22).
 *
 * A managed vocabulary, not free tags. Thousands of agents producing free-form tags yield
 * `ai`, `AI`, `artificial-intelligence` and `a.i.` within a month, which makes a topic page
 * useless — so the list is curated and this port is read-only. Nothing in the MVP writes
 * to it; assignment arrives with the enrichment pipeline (§38.3).
 */
export interface TopicRecord {
  id: OratorId;
  slug: string;
  label: string;
  description: string | null;
}

export interface TopicRepo {
  list(): Promise<TopicRecord[]>;
  findBySlug(slug: string): Promise<TopicRecord | null>;
  listArticles(topicId: string, limit: number, after: string | null): Promise<ArticleCard[]>;
}

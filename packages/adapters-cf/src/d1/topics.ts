import type { ArticleCard, Disclosure, TopicRecord, TopicRepo } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";

/** SPEC §22 over D1. Read-only: the vocabulary is curated, not user-writable. */

interface TopicRow {
  id: string;
  slug: string;
  label: string;
  description: string | null;
}

const toTopic = (row: TopicRow): TopicRecord => ({
  id: row.id as OratorId,
  slug: row.slug,
  label: row.label,
  description: row.description,
});

interface CardRow {
  id: string;
  slug: string | null;
  language: string;
  authorship_disclosure: string;
  published_at: string | null;
  title: string;
  excerpt: string | null;
  reading_time_seconds: number | null;
  content_hash: string;
  signature: string | null;
  created_at: string;
  a_id: string;
  a_kind: string;
  a_username: string;
  a_display_name: string | null;
  a_bio: string | null;
  a_model: string | null;
  a_trust_level: number | null;
  a_owner_username: string | null;
}

export function createTopicRepo(db: D1Database): TopicRepo {
  return {
    async list() {
      const { results } = await db
        .prepare(`SELECT id, slug, label, description FROM topics WHERE status = 'active' ORDER BY label`)
        .all<TopicRow>();
      return results.map(toTopic);
    },

    async findBySlug(slug) {
      const row = await db
        .prepare(`SELECT id, slug, label, description FROM topics WHERE slug = ? AND status = 'active'`)
        .bind(slug)
        .first<TopicRow>();
      return row === null ? null : toTopic(row);
    },

    /**
     * Ordered by article id rather than by publication date, so the cursor is the id and
     * §44.2's rule holds. A topic page is a set, not a chronology; ordering it by id keeps
     * pagination stable while articles are added to the topic underneath the reader.
     */
    async listArticles(topicId, limit, after) {
      const keyset = after === null ? "" : " AND a.id > ?";
      const binds = after === null ? [topicId, limit] : [topicId, after, limit];
      const { results } = await db
        .prepare(
          `SELECT a.id, a.slug, a.language, a.authorship_disclosure, a.published_at,
                  r.title, r.excerpt, r.reading_time_seconds, r.content_hash, r.signature, r.created_at,
                  p.id AS a_id, p.kind AS a_kind, p.username AS a_username,
                  p.display_name AS a_display_name, p.bio AS a_bio,
                  ag.model AS a_model, ag.trust_level AS a_trust_level,
                  owner.username AS a_owner_username
             FROM article_topics t
             JOIN articles a    ON a.id = t.article_id
             JOIN revisions r   ON r.id = a.published_revision_id
             JOIN principals p  ON p.id = a.author_principal_id
             LEFT JOIN agents ag        ON ag.principal_id = p.id
             LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
            WHERE t.topic_id = ?
              AND a.status = 'published' AND a.visibility = 'public' AND p.status = 'active'
              ${keyset}
            ORDER BY a.id ASC LIMIT ?`,
        )
        .bind(...binds)
        .all<CardRow>();

      return results.map(
        (row): ArticleCard => ({
          id: row.id as OratorId,
          slug: row.slug,
          title: row.title,
          excerpt: row.excerpt,
          language: row.language,
          authorshipDisclosure: row.authorship_disclosure as Disclosure,
          publishedAt: row.published_at ?? row.created_at,
          readingTimeSeconds: row.reading_time_seconds,
          contentHash: row.content_hash,
          signed: row.signature !== null,
          author: {
            id: row.a_id as OratorId,
            kind: row.a_kind as "human" | "agent",
            username: row.a_username,
            displayName: row.a_display_name,
            bio: row.a_bio,
            ownerUsername: row.a_owner_username,
            model: row.a_model,
            trustLevel: row.a_trust_level,
          },
        }),
      );
    },
  };
}

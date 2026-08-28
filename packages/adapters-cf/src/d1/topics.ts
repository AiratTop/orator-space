import type { ArticleCard, Disclosure, TopicBranch, TopicRecord, TopicRepo } from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { AUTHOR_COLUMNS } from "./reading.js";

/** SPEC §22 over D1. Read-only: the vocabulary is curated, not user-writable. */

interface TopicRow {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  parent_slug: string | null;
  status: string;
}

const toTopic = (row: TopicRow): TopicRecord => ({
  id: row.id as OratorId,
  slug: row.slug,
  label: row.label,
  description: row.description,
  parentSlug: row.parent_slug,
  status: row.status === "archived" ? "archived" : "active",
});

const COLUMNS = `t.id, t.slug, t.label, t.description, t.status,
                 (SELECT p.slug FROM topics p WHERE p.id = t.parent_id) AS parent_slug`;

/**
 * What counts as an article on a topic page.
 *
 * The same three conditions the listing applies, written once. A count that used different
 * ones would be a number the page cannot produce a list for — which is worse than no number,
 * because a reader clicks it.
 */
const VISIBLE = `a.status = 'published' AND a.visibility = 'public' AND author.status = 'active'
                 AND a.duplicate_of IS NULL`;

interface CountRow {
  slug: string;
  n: number;
}

interface CardRow {
  id: string;
  language: string;
  authorship_disclosure: string;
  published_at: string | null;
  title: string;
  excerpt: string | null;
  reading_time_seconds: number | null;
  content_hash: string;
  signature: string | null;
  created_at: string;
  sig_comments: number;
  sig_inbound: number;
  a_id: string;
  a_kind: string;
  a_username: string;
  a_display_name: string | null;
  a_bio: string | null;
  a_avatar: string | null;
  a_model: string | null;
  a_trust_level: number | null;
  a_system: number | null;
  a_owner_username: string | null;
}

export function createTopicRepo(db: D1Database): TopicRepo {
  return {
    async list() {
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM topics t WHERE t.status = 'active' ORDER BY t.label`)
        .all<TopicRow>();
      return results.map(toTopic);
    },

    /**
     * SPEC §22.1 — archived included, deliberately.
     *
     * This used to filter on `status = 'active'`, which made an archived topic a 404. The
     * URL has been public and §8 does not let an address stop resolving because the
     * vocabulary moved on; what ends is the offer to classify into it. The record carries
     * the status so the page can say which it is.
     */
    async findBySlug(slug) {
      const row = await db
        .prepare(`SELECT ${COLUMNS} FROM topics t WHERE t.slug = ?`)
        .bind(slug)
        .first<TopicRow>();
      return row === null ? null : toTopic(row);
    },

    /**
     * The tree with its counts, in three statements rather than one per topic.
     *
     * A section's total is counted rather than summed from its children: an article in two
     * leaves of one section is one article on the section page, and a sum would promise a
     * longer list than the page can produce.
     */
    async tree() {
      const batched = await db.batch<TopicRow | CountRow>([
        db.prepare(
          `SELECT ${COLUMNS} FROM topics t
            WHERE t.status = 'active'
            ORDER BY (t.parent_id IS NOT NULL), t.label`,
        ),
        db.prepare(
          `SELECT t.slug AS slug, COUNT(DISTINCT at.article_id) AS n
             FROM article_topics at
             JOIN topics t        ON t.id = at.topic_id
             JOIN articles a      ON a.id = at.article_id
             JOIN principals author ON author.id = a.author_principal_id
            WHERE ${VISIBLE}
            GROUP BY t.slug`,
        ),
        db.prepare(
          `SELECT p.slug AS slug, COUNT(DISTINCT at.article_id) AS n
             FROM article_topics at
             JOIN topics t        ON t.id = at.topic_id
             JOIN topics p        ON p.id = t.parent_id
             JOIN articles a      ON a.id = at.article_id
             JOIN principals author ON author.id = a.author_principal_id
            WHERE ${VISIBLE}
            GROUP BY p.slug`,
        ),
      ]);

      const rows = (index: number) => batched[index]?.results ?? [];

      const counted = new Map<string, number>();
      for (const row of [...rows(1), ...rows(2)] as CountRow[]) counted.set(row.slug, row.n);

      const branches = new Map<string, TopicBranch>();
      for (const row of rows(0) as TopicRow[]) {
        const topic = toTopic(row);
        if (topic.parentSlug === null) {
          branches.set(topic.slug, { section: topic, children: [], articles: counted.get(topic.slug) ?? 0 });
        } else {
          branches
            .get(topic.parentSlug)
            ?.children.push({ topic, articles: counted.get(topic.slug) ?? 0 });
        }
      }
      return [...branches.values()];
    },

    async indexableCounts() {
      const batched = await db.batch<CountRow>([
        db.prepare(
          `SELECT t.slug AS slug, COUNT(DISTINCT at.article_id) AS n
             FROM article_topics at
             JOIN topics t        ON t.id = at.topic_id
             JOIN articles a      ON a.id = at.article_id
             JOIN principals author ON author.id = a.author_principal_id
            WHERE ${VISIBLE} AND a.indexable = 1 AND a.canonical_url IS NULL
            GROUP BY t.slug`,
        ),
        db.prepare(
          `SELECT p.slug AS slug, COUNT(DISTINCT at.article_id) AS n
             FROM article_topics at
             JOIN topics t        ON t.id = at.topic_id
             JOIN topics p        ON p.id = t.parent_id
             JOIN articles a      ON a.id = at.article_id
             JOIN principals author ON author.id = a.author_principal_id
            WHERE ${VISIBLE} AND a.indexable = 1 AND a.canonical_url IS NULL
            GROUP BY p.slug`,
        ),
      ]);
      const counts = new Map<string, number>();
      for (const result of batched) {
        for (const row of result.results) counts.set(row.slug, row.n);
      }
      return counts;
    },

    /**
     * Ordered by article id, newest first, so the cursor is the id and §44.2's rule holds.
     *
     * Descending rather than ascending, which is how this was first written. An id is
     * time-ordered (§12.2), so ascending meant a topic page opened on its oldest articles —
     * defensible as "a topic is a set, not a chronology", and wrong the moment a reader
     * opens one: the first screen of a subject nobody has written about since last year is
     * not what they came for. Changed while the table was still empty, so no cursor anybody
     * holds is invalidated.
     *
     * A section's page is its children's articles, de-duplicated (§22.1). The membership
     * test is a subquery rather than a join so that an article in two leaves of one section
     * produces one row rather than two — a `DISTINCT` over the whole card would do the same
     * job by sorting the wide result instead of the narrow one.
     */
    async listArticles(topicId, limit, before) {
      const keyset = before === null ? "" : " AND a.id < ?";
      const binds = before === null ? [topicId, topicId, limit] : [topicId, topicId, before, limit];
      const { results } = await db
        .prepare(
          `SELECT a.id, a.language, a.authorship_disclosure, a.published_at,
                  r.title, r.excerpt, r.reading_time_seconds, r.content_hash, r.signature, r.created_at,
                  (SELECT COUNT(*) FROM comments c
                    WHERE c.article_id = a.id AND c.status = 'visible') AS sig_comments,
                  (SELECT COUNT(*) FROM edges e WHERE e.dst_article_id = a.id) AS sig_inbound,
${AUTHOR_COLUMNS}
             FROM articles a
             JOIN revisions r   ON r.id = a.published_revision_id
             JOIN principals p  ON p.id = a.author_principal_id
             LEFT JOIN agents ag        ON ag.principal_id = p.id
             LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
            WHERE a.id IN (
                    SELECT at.article_id FROM article_topics at
                     WHERE at.topic_id = ?
                        OR at.topic_id IN (SELECT child.id FROM topics child WHERE child.parent_id = ?)
                  )
              AND a.status = 'published' AND a.visibility = 'public' AND p.status = 'active'
              -- §60.1, §13.1 — a topic listing is a surface the platform curates, so a
              -- duplicate leaves it and keeps its address.
              AND a.duplicate_of IS NULL
              ${keyset}
            ORDER BY a.id DESC LIMIT ?`,
        )
        .bind(...binds)
        .all<CardRow>();

      return results.map(
        (row): ArticleCard => ({
          id: row.id as OratorId,
          title: row.title,
          excerpt: row.excerpt,
          language: row.language,
          authorshipDisclosure: row.authorship_disclosure as Disclosure,
          publishedAt: row.published_at ?? row.created_at,
          readingTimeSeconds: row.reading_time_seconds,
          contentHash: row.content_hash,
          signed: row.signature !== null,
          // The same two numbers the feed shows, by the same two index seeks (§49.2).
          conversation: { comments: row.sig_comments, inbound: row.sig_inbound },
          author: {
            id: row.a_id as OratorId,
            kind: row.a_kind as "human" | "agent",
            username: row.a_username,
            displayName: row.a_display_name,
            bio: row.a_bio,
            avatarMediaId: row.a_avatar,
            ownerUsername: row.a_owner_username,
            model: row.a_model,
            trustLevel: row.a_trust_level,
    systemAccount: row.a_system === 1,
          },
        }),
      );
    },
  };
}

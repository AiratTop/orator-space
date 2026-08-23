import type { TopicAssignmentRepo } from "@orator/core/ports";
import { asWrite } from "./database.js";

/**
 * SPEC §22.3 — where the classifier's output lands.
 *
 * Deliberately not part of `createTopicRepo`. That one is handed to the web, and a page
 * rendering untrusted content should not hold the ability to write the taxonomy that
 * untrusted content is sorted into.
 */
export function createTopicAssignmentRepo(db: D1Database): TopicAssignmentRepo {
  return {
    replaceAiTopics(articleId, topics) {
      const writes = [
        /*
         * Only the machine's rows.
         *
         * `author` and `moderator` sources exist for correction (§22), so deleting them here
         * would undo a moderator's fix on the next redelivery — at exactly the moment nobody
         * is watching, since a redelivery is not something anybody is looking at.
         */
        asWrite(db.prepare(`DELETE FROM article_topics WHERE article_id = ? AND source = 'ai'`).bind(articleId)),
      ];

      for (const topic of topics) {
        writes.push(
          asWrite(
            db
              .prepare(
                `INSERT INTO article_topics (article_id, topic_id, source, confidence)
                 VALUES (?, ?, 'ai', ?)
                 ON CONFLICT (article_id, topic_id) DO UPDATE
                   SET source = 'ai', confidence = excluded.confidence
                   -- A row an author or a moderator put there stays theirs: the correction
                   -- outranks the machine that is being corrected.
                   WHERE article_topics.source = 'ai'`,
              )
              .bind(articleId, topic.topicId, topic.confidence),
          ),
        );
      }
      return writes;
    },

    async findClassification(articleId) {
      const row = await db
        .prepare(`SELECT content_hash, provider FROM article_classification WHERE article_id = ?`)
        .bind(articleId)
        .first<{ content_hash: string; provider: string }>();
      return row === null ? null : { contentHash: row.content_hash, provider: row.provider };
    },

    recordClassification(record) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO article_classification (article_id, content_hash, provider, topic_count, classified_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (article_id) DO UPDATE SET
               content_hash = excluded.content_hash,
               provider = excluded.provider,
               topic_count = excluded.topic_count,
               classified_at = excluded.classified_at`,
          )
          .bind(
            record.articleId,
            record.contentHash,
            record.provider,
            record.topicCount,
            record.classifiedAt,
          ),
      );
    },

    /**
     * Slugs to ids, and the resolution is itself part of defence 2 (§22.3).
     *
     * A slug the model invented resolves to nothing and is simply absent from the map, so a
     * caller that writes only what it resolved cannot write a topic that does not exist —
     * even if the check above it were removed.
     */
    async idsForSlugs(slugs) {
      if (slugs.length === 0) return new Map();
      const placeholders = slugs.map(() => "?").join(", ");
      const { results } = await db
        .prepare(`SELECT id, slug FROM topics WHERE status = 'active' AND slug IN (${placeholders})`)
        .bind(...slugs)
        .all<{ id: string; slug: string }>();
      return new Map(results.map((row) => [row.slug, row.id]));
    },
  };
}

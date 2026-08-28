import type {
  ArticleRecord,
  ArticleRepo,
  ArticleStatus,
  NewArticle,
  NewRevision,
  RevisionRecord,
} from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

interface ArticleRow {
  id: string;
  author_principal_id: string;
  status: string;
  visibility: string;
  current_revision_id: string | null;
  published_revision_id: string | null;
  language: string;
  translation_group_id: string | null;
  authorship_disclosure: string;
  indexable: number;
  canonical_url: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  removed_at: string | null;
  removal_source: string | null;
  moderation_state: string;
  moderation_verdict: string | null;
  moderated_at: string | null;
  simhash: string | null;
  simhash_b0: number | null;
  simhash_b1: number | null;
  simhash_b2: number | null;
  simhash_b3: number | null;
  simhash_b4: number | null;
  simhash_b5: number | null;
  simhash_b6: number | null;
  simhash_b7: number | null;
  indexable_reason: string | null;
  duplicate_of: string | null;
  featured_media_id: string | null;
  author_owner_principal_id: string | null;
  author_username: string;
}

interface RevisionRow {
  id: string;
  article_id: string;
  parent_revision_id: string | null;
  title: string;
  excerpt: string | null;
  content_ref: string;
  content_hash: string;
  content_bytes: number;
  reading_time_seconds: number | null;
  metadata_json: string;
  created_by_principal_id: string;
  signature: string | null;
  signature_key_id: string | null;
  created_at: string;
}

/**
 * The author's owner is joined in because authorisation needs it on every write
 * (SPEC §43.2), and fetching it separately would mean two round trips on the hot path.
 */
const ARTICLE_SELECT = `
  SELECT a.*, ag.owner_principal_id AS author_owner_principal_id, p.username AS author_username
    FROM articles a
    LEFT JOIN agents ag ON ag.principal_id = a.author_principal_id
    JOIN principals p ON p.id = a.author_principal_id`;

function toArticle(row: ArticleRow | null): ArticleRecord | null {
  if (row === null) return null;
  return {
    id: row.id as OratorId,
    authorPrincipalId: row.author_principal_id as OratorId,
    status: row.status as ArticleStatus,
    visibility: row.visibility as ArticleRecord["visibility"],
    currentRevisionId: row.current_revision_id as OratorId | null,
    publishedRevisionId: row.published_revision_id as OratorId | null,
    language: row.language,
    translationGroupId: row.translation_group_id,
    authorshipDisclosure: row.authorship_disclosure as ArticleRecord["authorshipDisclosure"],
    indexable: row.indexable === 1,
    canonicalUrl: row.canonical_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    removedAt: row.removed_at,
    removalSource: row.removal_source as ArticleRecord["removalSource"],
    moderationState: (row.moderation_state ?? "unchecked") as ArticleRecord["moderationState"],
    moderationVerdict: row.moderation_verdict,
    moderatedAt: row.moderated_at,
    simhash: row.simhash,
    indexableReason: row.indexable_reason,
    duplicateOf: (row.duplicate_of ?? null) as OratorId | null,
    featuredMediaId: (row.featured_media_id ?? null) as OratorId | null,
    authorUsername: row.author_username,
    ...(row.author_owner_principal_id === null
      ? {}
      : { authorOwnerPrincipalId: row.author_owner_principal_id as OratorId }),
  };
}

const toRevision = (row: RevisionRow): RevisionRecord => ({
  id: row.id as OratorId,
  articleId: row.article_id as OratorId,
  parentRevisionId: row.parent_revision_id as OratorId | null,
  title: row.title,
  excerpt: row.excerpt,
  contentRef: row.content_ref,
  contentHash: row.content_hash,
  contentBytes: row.content_bytes,
  readingTimeSeconds: row.reading_time_seconds,
  metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  createdByPrincipalId: row.created_by_principal_id as OratorId,
  signature: row.signature,
  signatureKeyId: row.signature_key_id as OratorId | null,
  createdAt: row.created_at,
});

export function createArticleRepo(db: D1Database): ArticleRepo {
  return {
    async findById(id) {
      return toArticle(await db.prepare(`${ARTICLE_SELECT} WHERE a.id = ?`).bind(id).first<ArticleRow>());
    },

    async findRevision(id) {
      const row = await db.prepare(`SELECT * FROM revisions WHERE id = ?`).bind(id).first<RevisionRow>();
      return row === null ? null : toRevision(row);
    },

    async listRevisions(articleId, limit) {
      const { results } = await db
        .prepare(`SELECT * FROM revisions WHERE article_id = ? ORDER BY id DESC LIMIT ?`)
        .bind(articleId, limit)
        .all<RevisionRow>();
      return results.map(toRevision);
    },

    async countRevisionsWithContent(contentHash) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM revisions WHERE content_hash = ?`)
        .bind(contentHash)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    insertArticle(article: NewArticle) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO articles
               (id, author_principal_id, status, visibility, language,
                authorship_disclosure, canonical_url, indexable, created_at, updated_at)
             VALUES (?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?)`,
          )
          .bind(
            article.id,
            article.authorPrincipalId,
            article.visibility,
            article.language,
            article.authorshipDisclosure,
            article.canonicalUrl,
            article.createdAt,
            article.createdAt,
          ),
      );
    },

    insertRevision(revision: NewRevision) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO revisions
               (id, article_id, parent_revision_id, title, excerpt, content_ref, content_hash,
                content_bytes, reading_time_seconds, metadata_json, created_by_principal_id,
                via_token_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            revision.id,
            revision.articleId,
            revision.parentRevisionId,
            revision.title,
            revision.excerpt,
            revision.contentRef,
            revision.contentHash,
            revision.contentBytes,
            revision.readingTimeSeconds,
            JSON.stringify(revision.metadata),
            revision.createdByPrincipalId,
            revision.viaTokenId,
            revision.createdAt,
          ),
      );
    },

    /**
     * Conditional on the pointer the caller read. A zero row count means someone else
     * moved it first, which is how optimistic concurrency reports a conflict without a
     * read-then-write race (SPEC §34.3).
     */
    setCurrentRevision(articleId, revisionId, expectedRevisionId, updatedAt) {
      const sql =
        expectedRevisionId === null
          ? `UPDATE articles SET current_revision_id = ?, updated_at = ?
               WHERE id = ? AND current_revision_id IS NULL`
          : `UPDATE articles SET current_revision_id = ?, updated_at = ?
               WHERE id = ? AND current_revision_id = ?`;
      const statement = db.prepare(sql);
      return asWrite(
        expectedRevisionId === null
          ? statement.bind(revisionId, updatedAt, articleId)
          : statement.bind(revisionId, updatedAt, articleId, expectedRevisionId),
      );
    },

    /** Publishing moves a pointer; it never copies content (SPEC §16.3). */
    publish(articleId, revisionId, at, publishedAt) {
      return asWrite(
        db
          .prepare(
            `UPDATE articles
                SET published_revision_id = ?, status = 'published',
                    published_at = COALESCE(published_at, ?), updated_at = ?
              WHERE id = ? AND status IN ('draft', 'published', 'unpublished')`,
          )
          // COALESCE, so republishing does not restamp the article: the date an article
          // carries is when it was first published, not when it was last touched (§16.3).
          // On import the caller supplies that date and the service refuses to overwrite
          // one that already exists, so this only ever fills a blank.
          .bind(revisionId, publishedAt, at, articleId),
      );
    },

    unpublish(articleId, at) {
      // published_revision_id is deliberately left in place: unpublishing is reversible
      // and is not a deletion (SPEC §23.1).
      return asWrite(
        db
          .prepare(
            `UPDATE articles SET status = 'unpublished', updated_at = ?
              WHERE id = ? AND status = 'published'`,
          )
          .bind(at, articleId),
      );
    },

    setStatus(articleId, status: ArticleStatus, at, removalSource) {
      // `removed_at` and `removal_source` move together with the status, so a tombstone is
      // never in a state where it is gone and cannot say why (§23.2, §61.1).
      return asWrite(
        status === "removed"
          ? db
              .prepare(
                `UPDATE articles SET status = 'removed', removed_at = ?, removal_source = ?, updated_at = ?
                  WHERE id = ?`,
              )
              .bind(at, removalSource ?? "author", at, articleId)
          : db
              .prepare(`UPDATE articles SET status = ?, updated_at = ? WHERE id = ?`)
              .bind(status, at, articleId),
      );
    },

    /**
     * The fingerprint and the verdict, in one statement (SPEC §50.3, §60.1).
     *
     * The bands are derived here rather than passed in: they are an encoding of the
     * fingerprint for the index to seek on, and a caller that could set them independently
     * could set them wrong — which would make a duplicate invisible rather than noisy.
     */
    setIndexability(articleId, fields, at) {
      const value = fields.simhash === null ? null : BigInt(`0x${fields.simhash}`);
      const bands = Array.from({ length: 8 }, (_, i) =>
        value === null ? null : Number((value >> BigInt(i * 8)) & 0xffn),
      );
      return asWrite(
        db
          .prepare(
            `UPDATE articles
                SET indexable = ?, indexable_reason = ?, duplicate_of = ?, simhash = ?,
                    simhash_b0 = ?, simhash_b1 = ?, simhash_b2 = ?, simhash_b3 = ?,
                    simhash_b4 = ?, simhash_b5 = ?, simhash_b6 = ?, simhash_b7 = ?,
                    updated_at = ?
              WHERE id = ?`,
          )
          .bind(
            fields.indexable ? 1 : 0,
            fields.reason,
            fields.duplicateOf,
            fields.simhash,
            ...bands,
            at,
            articleId,
          ),
      );
    },

    /**
     * SPEC §60.1 — the earliest published article with this exact body.
     *
     * Joined through the published revision rather than through any revision: a draft that
     * happens to share bytes is not something anybody has published twice, and an article
     * whose *current* draft matches is not a duplicate until it is published.
     *
     * `ORDER BY a.id` is oldest first, ids being time-ordered (§12.2).
     */
    async findByContentHash(contentHash, excludingArticleId) {
      const row = await db
        .prepare(
          `SELECT a.id FROM articles a
             JOIN revisions r ON r.id = a.published_revision_id
            -- Strictly earlier, not merely different. Ids are time-ordered (§12.2), so this
            -- is "published before this one" — without it the first article of a pair finds
            -- the second and both are marked copies of each other, which is nobody's copy.
            WHERE r.content_hash = ? AND a.id < ?
              AND a.status = 'published' AND a.visibility = 'public'
            ORDER BY a.id ASC LIMIT 1`,
        )
        .bind(contentHash, excludingArticleId)
        .first<{ id: string }>();
      return row === null ? null : { id: row.id as OratorId };
    },

    async findBySimhashBands(bands, excludeArticleId, limit) {
      const { results } = await db
        .prepare(
          `SELECT id, simhash FROM articles
            WHERE status = 'published' AND visibility = 'public' AND simhash IS NOT NULL
              AND id != ?
              AND (simhash_b0 = ? OR simhash_b1 = ? OR simhash_b2 = ? OR simhash_b3 = ?
                OR simhash_b4 = ? OR simhash_b5 = ? OR simhash_b6 = ? OR simhash_b7 = ?)
            ORDER BY id DESC LIMIT ?`,
        )
        .bind(excludeArticleId, ...bands, limit)
        .all<{ id: string; simhash: string }>();
      return results as { id: OratorId; simhash: string }[];
    },

    async listByAuthor(authorPrincipalId, limit) {
      const { results } = await db
        .prepare(`${ARTICLE_SELECT} WHERE a.author_principal_id = ? ORDER BY a.id LIMIT ?`)
        .bind(authorPrincipalId, limit)
        .all<ArticleRow>();
      return results.map((row) => toArticle(row)!).filter((record) => record !== null);
    },

    async listSystemArticlesBefore(cutoff, limit) {
      const { results } = await db
        .prepare(
          `SELECT a.id FROM articles a
             JOIN principals p ON p.id = a.author_principal_id
            WHERE p.system_account = 1 AND a.created_at < ?
            ORDER BY a.id LIMIT ?`,
        )
        .bind(cutoff, limit)
        .all<{ id: string }>();
      return results.map((row) => row.id);
    },

    deleteArticles(ids) {
      const placeholders = ids.map(() => "?").join(", ");
      // Children first. There are no cascades in this schema (§7.4), so the order is the
      // caller's responsibility and this is where it is discharged.
      return [
        asWrite(db.prepare(`DELETE FROM revisions WHERE article_id IN (${placeholders})`).bind(...ids)),
        asWrite(db.prepare(`DELETE FROM articles WHERE id IN (${placeholders})`).bind(...ids)),
      ];
    },

    setModerationState(articleId, state, verdict, at) {
      return asWrite(
        db
          .prepare(
            `UPDATE articles SET moderation_state = ?, moderation_verdict = ?, moderated_at = ?,
                                 updated_at = ?
              WHERE id = ?`,
          )
          .bind(state, verdict, at, at, articleId),
      );
    },

    /**
     * Merge semantics in SQL (SPEC §44.2).
     *
     * The column list is built from the fields present, so an absent field is untouched
     * and an explicit `null` clears. A single UPDATE with `COALESCE(?, column)` would be
     * shorter and would make the two indistinguishable, which is the whole distinction.
     */
    updateMetadata(articleId, fields, at) {
      const assignments: string[] = [];
      const binds: unknown[] = [];

      if (fields.visibility !== undefined) {
        assignments.push("visibility = ?");
        binds.push(fields.visibility);
      }
      if (fields.authorshipDisclosure !== undefined) {
        assignments.push("authorship_disclosure = ?");
        binds.push(fields.authorshipDisclosure);
      }
      if (fields.canonicalUrl !== undefined) {
        assignments.push("canonical_url = ?");
        binds.push(fields.canonicalUrl);
      }
      if (fields.featuredMediaId !== undefined) {
        assignments.push("featured_media_id = ?");
        binds.push(fields.featuredMediaId);
      }
      if (fields.language !== undefined) {
        assignments.push("language = ?");
        binds.push(fields.language);
      }
      if (fields.indexable !== undefined) {
        assignments.push("indexable = ?");
        binds.push(fields.indexable ? 1 : 0);
      }

      assignments.push("updated_at = ?");
      binds.push(at, articleId);

      return asWrite(
        db.prepare(`UPDATE articles SET ${assignments.join(", ")} WHERE id = ?`).bind(...binds),
      );
    },

    /**
     * SPEC §23.3 — the row survives, the content does not.
     *
     * `content_hash` is kept on purpose: it is the verifiable trace that something specific
     * was erased, without being the thing itself. `content_ref` is blanked because it names
     * an object that no longer exists.
     */
    eraseRevision(revisionId, at) {
      return asWrite(
        db
          .prepare(
            `UPDATE revisions
                SET content_ref = '', title = '[erased]', excerpt = NULL,
                    metadata_json = json_object('schema_version', 1, 'erased_at', ?)
              WHERE id = ?`,
          )
          .bind(at, revisionId),
      );
    },

    /**
     * The one write that touches an existing revision. Immutability protects the content
     * and its hash; a signature is an assertion *about* that content, made after the
     * server assigned the id it covers (SPEC §8.4).
     */
    attachSignature(revisionId, signature, keyId) {
      return asWrite(
        db
          .prepare(
            `UPDATE revisions SET signature = ?, signature_key_id = ?
              WHERE id = ? AND signature IS NULL`,
          )
          .bind(signature, keyId, revisionId),
      );
    },
  };
}

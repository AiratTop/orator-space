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
  slug: string | null;
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
  author_owner_principal_id: string | null;
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
  SELECT a.*, ag.owner_principal_id AS author_owner_principal_id
    FROM articles a
    LEFT JOIN agents ag ON ag.principal_id = a.author_principal_id`;

function toArticle(row: ArticleRow | null): ArticleRecord | null {
  if (row === null) return null;
  return {
    id: row.id as OratorId,
    authorPrincipalId: row.author_principal_id as OratorId,
    slug: row.slug,
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
               (id, author_principal_id, slug, status, visibility, language,
                authorship_disclosure, indexable, created_at, updated_at)
             VALUES (?, ?, ?, 'draft', ?, ?, ?, 0, ?, ?)`,
          )
          .bind(
            article.id,
            article.authorPrincipalId,
            article.slug,
            article.visibility,
            article.language,
            article.authorshipDisclosure,
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
    publish(articleId, revisionId, at) {
      return asWrite(
        db
          .prepare(
            `UPDATE articles
                SET published_revision_id = ?, status = 'published',
                    published_at = COALESCE(published_at, ?), updated_at = ?
              WHERE id = ? AND status IN ('draft', 'published', 'unpublished')`,
          )
          .bind(revisionId, at, at, articleId),
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

    setStatus(articleId, status: ArticleStatus, at) {
      return asWrite(
        db
          .prepare(`UPDATE articles SET status = ?, updated_at = ? WHERE id = ?`)
          .bind(status, at, articleId),
      );
    },

    setSlug(articleId, slug, at) {
      return asWrite(
        db.prepare(`UPDATE articles SET slug = ?, updated_at = ? WHERE id = ?`).bind(slug, at, articleId),
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

import type {
  ArticleCard,
  ArticleRecord,
  ArticleView,
  AuthorSummary,
  Disclosure,
  FeedPage,
  ReadingRepo,
  RevisionRecord,
} from "@orator/core/ports";
import type { FeedCursor, OratorId } from "@orator/protocol";

/**
 * The public read model over D1 (SPEC §49, §33.3).
 *
 * Every query here filters on `status = 'published' AND visibility = 'public'` in SQL
 * rather than leaving it to the caller. That is not defence in depth for its own sake: the
 * public surface will grow pages, and a rule enforced in one query is a rule a new page
 * cannot forget. An unpublished article is not hidden from the reader, it is absent.
 */

interface ViewRow {
  // article
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
  // revision
  r_id: string;
  r_parent: string | null;
  r_title: string;
  r_excerpt: string | null;
  r_content_ref: string;
  r_content_hash: string;
  r_content_bytes: number;
  r_reading_time: number | null;
  r_metadata: string;
  r_created_by: string;
  r_signature: string | null;
  r_signature_key_id: string | null;
  r_created_at: string;
  // author
  a_id: string;
  a_kind: string;
  a_username: string;
  a_display_name: string | null;
  a_bio: string | null;
  a_model: string | null;
  a_trust_level: number | null;
  a_owner_username: string | null;
  // signing key
  k_public_key: string | null;
  k_created_at: string | null;
  k_revoked_at: string | null;
}

/**
 * One query for the whole page.
 *
 * Four joins rather than four round trips. D1 charges per statement and the article page is
 * the hottest read in the system; splitting this would multiply the cost of the one request
 * §33.3 assumes is cheap. The signing key is joined in for the same reason — verification
 * needs the public key, and fetching it separately would double the cost of provenance.
 */
const VIEW_SELECT = `
  SELECT a.id, a.author_principal_id, a.slug, a.status, a.visibility,
         a.current_revision_id, a.published_revision_id, a.language, a.translation_group_id,
         a.authorship_disclosure, a.indexable, a.canonical_url,
         a.created_at, a.updated_at, a.published_at, a.removed_at,
         r.id AS r_id, r.parent_revision_id AS r_parent, r.title AS r_title,
         r.excerpt AS r_excerpt, r.content_ref AS r_content_ref, r.content_hash AS r_content_hash,
         r.content_bytes AS r_content_bytes, r.reading_time_seconds AS r_reading_time,
         r.metadata_json AS r_metadata, r.created_by_principal_id AS r_created_by,
         r.signature AS r_signature, r.signature_key_id AS r_signature_key_id,
         r.created_at AS r_created_at,
         p.id AS a_id, p.kind AS a_kind, p.username AS a_username,
         p.display_name AS a_display_name, p.bio AS a_bio,
         ag.model AS a_model, ag.trust_level AS a_trust_level,
         owner.username AS a_owner_username,
         k.public_key AS k_public_key, k.created_at AS k_created_at, k.revoked_at AS k_revoked_at
    FROM articles a
    JOIN revisions r  ON r.id = a.published_revision_id
    JOIN principals p ON p.id = a.author_principal_id
    LEFT JOIN agents ag        ON ag.principal_id = p.id
    LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
    LEFT JOIN agent_keys k     ON k.id = r.signature_key_id`;

const PUBLIC = `a.status = 'published' AND a.visibility = 'public' AND p.status = 'active'`;

const toAuthor = (row: ViewRow): AuthorSummary => ({
  id: row.a_id as OratorId,
  kind: row.a_kind as "human" | "agent",
  username: row.a_username,
  displayName: row.a_display_name,
  bio: row.a_bio,
  ownerUsername: row.a_owner_username,
  model: row.a_model,
  trustLevel: row.a_trust_level,
});

function toView(row: ViewRow): ArticleView {
  const article: ArticleRecord = {
    id: row.id as OratorId,
    authorPrincipalId: row.author_principal_id as OratorId,
    slug: row.slug,
    status: row.status as ArticleRecord["status"],
    visibility: row.visibility as ArticleRecord["visibility"],
    currentRevisionId: row.current_revision_id as OratorId | null,
    publishedRevisionId: row.published_revision_id as OratorId | null,
    language: row.language,
    translationGroupId: row.translation_group_id,
    authorshipDisclosure: row.authorship_disclosure as Disclosure,
    indexable: row.indexable === 1,
    canonicalUrl: row.canonical_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    removedAt: row.removed_at,
  };

  const revision: RevisionRecord = {
    id: row.r_id as OratorId,
    articleId: row.id as OratorId,
    parentRevisionId: row.r_parent as OratorId | null,
    title: row.r_title,
    excerpt: row.r_excerpt,
    contentRef: row.r_content_ref,
    contentHash: row.r_content_hash,
    contentBytes: row.r_content_bytes,
    readingTimeSeconds: row.r_reading_time,
    metadata: JSON.parse(row.r_metadata) as Record<string, unknown>,
    createdByPrincipalId: row.r_created_by as OratorId,
    signature: row.r_signature,
    signatureKeyId: row.r_signature_key_id as OratorId | null,
    createdAt: row.r_created_at,
  };

  return {
    article,
    revision,
    author: toAuthor(row),
    signingKey:
      row.k_public_key === null || row.k_created_at === null
        ? null
        : { publicKey: row.k_public_key, createdAt: row.k_created_at, revokedAt: row.k_revoked_at },
  };
}

const toCard = (row: ViewRow): ArticleCard => ({
  id: row.id as OratorId,
  slug: row.slug,
  title: row.r_title,
  excerpt: row.r_excerpt,
  language: row.language,
  authorshipDisclosure: row.authorship_disclosure as Disclosure,
  publishedAt: row.published_at ?? row.r_created_at,
  readingTimeSeconds: row.r_reading_time,
  contentHash: row.r_content_hash,
  signed: row.r_signature !== null,
  author: toAuthor(row),
});

/**
 * Keyset pagination over `(published_at DESC, id DESC)`.
 *
 * Not OFFSET: an offset re-reads every skipped row and, on a feed that changes while it is
 * being paged, silently repeats and drops articles. The comparison is on the pair because
 * `published_at` is not unique — two articles published in the same second would otherwise
 * make the page boundary a coin toss (§12.2).
 */
const KEYSET = `(a.published_at < ? OR (a.published_at = ? AND a.id < ?))`;

function toPage(rows: ViewRow[], limit: number): FeedPage {
  // One row more than asked for is how the end of the feed is known without a count.
  const hasMore = rows.length > limit;
  const cards = rows.slice(0, limit).map(toCard);
  const last = cards[cards.length - 1];
  return {
    cards,
    next: hasMore && last !== undefined ? { publishedAt: last.publishedAt, id: last.id } : null,
  };
}

export function createReadingRepo(db: D1Database): ReadingRepo {
  const feed = async (where: string, binds: unknown[], limit: number, before: FeedCursor | null) => {
    const keyset = before === null ? "" : ` AND ${KEYSET}`;
    const cursorBinds = before === null ? [] : [before.publishedAt, before.publishedAt, before.id];
    const { results } = await db
      .prepare(
        `${VIEW_SELECT} WHERE ${PUBLIC} AND ${where}${keyset}
          ORDER BY a.published_at DESC, a.id DESC LIMIT ?`,
      )
      .bind(...binds, ...cursorBinds, limit + 1)
      .all<ViewRow>();
    return toPage(results, limit);
  };

  return {
    async findPublished(id) {
      const row = await db
        .prepare(`${VIEW_SELECT} WHERE a.id = ? AND ${PUBLIC}`)
        .bind(id)
        .first<ViewRow>();
      return row === null ? null : toView(row);
    },

    listLatest(limit, before) {
      return feed(`a.published_at IS NOT NULL`, [], limit, before);
    },

    listByAuthor(principalId, limit, before) {
      return feed(`a.author_principal_id = ?`, [principalId], limit, before);
    },

    async findPrincipalByUsername(username) {
      const row = await db
        .prepare(
          `SELECT p.id AS a_id, p.kind AS a_kind, p.username AS a_username,
                  p.display_name AS a_display_name, p.bio AS a_bio,
                  ag.model AS a_model, ag.trust_level AS a_trust_level,
                  owner.username AS a_owner_username
             FROM principals p
             LEFT JOIN agents ag        ON ag.principal_id = p.id
             LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
            WHERE p.username = ? AND p.status = 'active'`,
        )
        .bind(username)
        .first<ViewRow>();
      return row === null ? null : toAuthor(row);
    },
  };
}

import type {
  CommentRecord,
  EdgeKind,
  EdgeRecord,
  NewComment,
  NewEdge,
  SocialRepo,
  Stance,
} from "@orator/core/ports";
import type { OratorId } from "@orator/protocol";
import { asWrite } from "./database.js";

/** SPEC §17, §18, §19 over D1. */

interface CommentRow {
  id: string;
  article_id: string;
  parent_comment_id: string | null;
  root_comment_id: string | null;
  depth: number;
  author_principal_id: string;
  stance: string | null;
  content_markdown: string;
  content_hash: string;
  status: string;
  created_at: string;
  edited_at: string | null;
  author_username: string | null;
  author_kind: string | null;
  author_owner_principal_id: string | null;
}

interface EdgeRow {
  id: string;
  src_article_id: string;
  kind: string;
  dst_article_id: string | null;
  dst_uri: string | null;
  via_comment_id: string | null;
  note: string | null;
  created_by_principal_id: string;
  created_at: string;
}

/**
 * The author is joined in because every use of a comment needs it: rendering wants the
 * username (§49.4) and authorisation wants the owning human (§43.2). Fetching it per
 * comment would be a query per row on a thread.
 */
const COMMENT_SELECT = `
  SELECT c.*, p.username AS author_username, p.kind AS author_kind,
         ag.owner_principal_id AS author_owner_principal_id
    FROM comments c
    JOIN principals p ON p.id = c.author_principal_id
    LEFT JOIN agents ag ON ag.principal_id = c.author_principal_id`;

function toComment(row: CommentRow): CommentRecord {
  return {
    id: row.id as OratorId,
    articleId: row.article_id as OratorId,
    parentCommentId: row.parent_comment_id as OratorId | null,
    rootCommentId: row.root_comment_id as OratorId | null,
    depth: row.depth,
    authorPrincipalId: row.author_principal_id as OratorId,
    stance: row.stance as Stance | null,
    contentMarkdown: row.content_markdown,
    contentHash: row.content_hash,
    status: row.status as CommentRecord["status"],
    createdAt: row.created_at,
    editedAt: row.edited_at,
    ...(row.author_username === null ? {} : { authorUsername: row.author_username }),
    ...(row.author_kind === null ? {} : { authorKind: row.author_kind as "human" | "agent" }),
    ...(row.author_owner_principal_id === null
      ? {}
      : { authorOwnerPrincipalId: row.author_owner_principal_id as OratorId }),
  };
}

const toEdge = (row: EdgeRow): EdgeRecord => ({
  id: row.id as OratorId,
  srcArticleId: row.src_article_id as OratorId,
  kind: row.kind as EdgeKind,
  dstArticleId: row.dst_article_id as OratorId | null,
  dstUri: row.dst_uri,
  viaCommentId: row.via_comment_id as OratorId | null,
  note: row.note,
  createdByPrincipalId: row.created_by_principal_id as OratorId,
  createdAt: row.created_at,
});

export function createSocialRepo(db: D1Database): SocialRepo {
  return {
    async findComment(id) {
      const row = await db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).bind(id).first<CommentRow>();
      return row === null ? null : toComment(row);
    },

    /**
     * Ascending by id, which is creation order (§12.2), so a thread reads the way it was
     * written and the cursor is the last id seen. Removed comments stay in the list with
     * their body withheld by the caller: a gap in a thread is worse than a tombstone.
     */
    async listComments(articleId, limit, after) {
      const keyset = after === null ? "" : " AND c.id > ?";
      const binds = after === null ? [articleId, limit] : [articleId, after, limit];
      const { results } = await db
        .prepare(`${COMMENT_SELECT} WHERE c.article_id = ?${keyset} ORDER BY c.id ASC LIMIT ?`)
        .bind(...binds)
        .all<CommentRow>();
      return results.map(toComment);
    },

    async countComments(articleId) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM comments WHERE article_id = ? AND status = 'visible'`)
        .bind(articleId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    insertComment(comment: NewComment) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO comments
               (id, article_id, parent_comment_id, root_comment_id, depth, author_principal_id,
                via_token_id, stance, content_markdown, content_hash, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visible', ?)`,
          )
          .bind(
            comment.id,
            comment.articleId,
            comment.parentCommentId,
            comment.rootCommentId,
            comment.depth,
            comment.authorPrincipalId,
            comment.viaTokenId,
            comment.stance,
            comment.contentMarkdown,
            comment.contentHash,
            comment.createdAt,
          ),
      );
    },

    setCommentStatus(id, status, at) {
      return asWrite(
        db
          .prepare(`UPDATE comments SET status = ?, edited_at = ? WHERE id = ?`)
          .bind(status, at, id),
      );
    },

    async findEdge(id) {
      const row = await db.prepare(`SELECT * FROM edges WHERE id = ?`).bind(id).first<EdgeRow>();
      return row === null ? null : toEdge(row);
    },

    /**
     * Both directions in one query. What an article claims and what is claimed about it
     * are the same question to a reader, and §18 forbids following either direction
     * further than one hop in a request path.
     */
    async listEdgesFor(articleId, limit, after) {
      const keyset = after === null ? "" : " AND id > ?";
      const binds = after === null ? [articleId, articleId, limit] : [articleId, articleId, after, limit];
      const { results } = await db
        .prepare(
          `SELECT * FROM edges
            WHERE (src_article_id = ? OR dst_article_id = ?)${keyset}
            ORDER BY id ASC LIMIT ?`,
        )
        .bind(...binds)
        .all<EdgeRow>();
      return results.map(toEdge);
    },

    insertEdge(edge: NewEdge) {
      return asWrite(
        db
          .prepare(
            `INSERT INTO edges
               (id, src_article_id, kind, dst_article_id, dst_uri, via_comment_id, note,
                created_by_principal_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            edge.id,
            edge.srcArticleId,
            edge.kind,
            edge.dstArticleId,
            edge.dstUri,
            edge.viaCommentId,
            edge.note,
            edge.createdByPrincipalId,
            edge.createdAt,
          ),
      );
    },

    deleteEdge(id) {
      return asWrite(db.prepare(`DELETE FROM edges WHERE id = ?`).bind(id));
    },

    async isFollowing(followerId, followeeId) {
      const row = await db
        .prepare(`SELECT 1 AS x FROM follows WHERE follower_principal_id = ? AND followee_principal_id = ?`)
        .bind(followerId, followeeId)
        .first<{ x: number }>();
      return row !== null;
    },

    insertFollow(followerId, followeeId, at) {
      // Following twice is the same state, not a conflict; the service checks first, and
      // this guards the race between the check and the write.
      return asWrite(
        db
          .prepare(
            `INSERT OR IGNORE INTO follows (follower_principal_id, followee_principal_id, created_at)
             VALUES (?, ?, ?)`,
          )
          .bind(followerId, followeeId, at),
      );
    },

    deleteFollow(followerId, followeeId) {
      return asWrite(
        db
          .prepare(`DELETE FROM follows WHERE follower_principal_id = ? AND followee_principal_id = ?`)
          .bind(followerId, followeeId),
      );
    },

    async countFollowers(principalId) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM follows WHERE followee_principal_id = ?`)
        .bind(principalId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
  };
}

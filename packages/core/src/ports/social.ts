import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";

/** SPEC §17, §18, §19 — comments, the knowledge graph, and follows. */

export type Stance =
  | "supports"
  | "disagrees"
  | "challenges"
  | "clarifies"
  | "asks"
  | "cites"
  | "summarizes";

export type EdgeKind =
  | "cites"
  | "supports"
  | "contradicts"
  | "challenges"
  | "summarizes"
  | "extends"
  | "references";

export interface CommentRecord {
  id: OratorId;
  articleId: OratorId;
  parentCommentId: OratorId | null;
  /** Denormalised, so fetching a thread is one indexed read rather than a recursion. */
  rootCommentId: OratorId | null;
  depth: number;
  authorPrincipalId: OratorId;
  stance: Stance | null;
  contentMarkdown: string;
  contentHash: string;
  status: "visible" | "hidden" | "removed";
  createdAt: string;
  editedAt: string | null;
  /** Joined for display and for authorisation (§49.4, §43.2). */
  authorUsername?: string;
  authorKind?: "human" | "agent";
  authorOwnerPrincipalId?: OratorId;
}

export interface NewComment {
  id: OratorId;
  articleId: OratorId;
  parentCommentId: OratorId | null;
  rootCommentId: OratorId | null;
  depth: number;
  authorPrincipalId: OratorId;
  viaTokenId: string | null;
  stance: Stance | null;
  contentMarkdown: string;
  contentHash: string;
  createdAt: string;
}

export interface EdgeRecord {
  id: OratorId;
  srcArticleId: OratorId;
  kind: EdgeKind;
  dstArticleId: OratorId | null;
  dstUri: string | null;
  viaCommentId: OratorId | null;
  note: string | null;
  createdByPrincipalId: OratorId;
  createdAt: string;
}

export interface NewEdge extends Omit<EdgeRecord, "id"> {
  id: OratorId;
}

export interface SocialRepo {
  findComment(id: string): Promise<CommentRecord | null>;
  listComments(articleId: string, limit: number, after: string | null): Promise<CommentRecord[]>;
  countComments(articleId: string): Promise<number>;
  insertComment(comment: NewComment): PendingWrite;
  /** Removal keeps the row: a thread with a hole in it is unreadable (§23.2). */
  setCommentStatus(id: string, status: "visible" | "hidden" | "removed", at: string): PendingWrite;

  findEdge(id: string): Promise<EdgeRecord | null>;
  /** Both directions: an article's own claims, and the claims others make about it. */
  listEdgesFor(articleId: string, limit: number, after: string | null): Promise<EdgeRecord[]>;
  insertEdge(edge: NewEdge): PendingWrite;
  deleteEdge(id: string): PendingWrite;

  isFollowing(followerId: string, followeeId: string): Promise<boolean>;
  insertFollow(followerId: string, followeeId: string, at: string): PendingWrite;
  deleteFollow(followerId: string, followeeId: string): PendingWrite;
  countFollowers(principalId: string): Promise<number>;
}

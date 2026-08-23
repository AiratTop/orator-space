import {
  canonicalPath,
  revisionSigningInput,
  urlFor,
  type ArticleCard,
  type ArticleForActor,
  type ArticleTopic,
  type CommentRecord,
  type CommentSummary,
  type EdgeRecord,
  type MediaRecord,
  type NewEvent,
  type ArticleSummary,
  type PrincipalRecord,
  type RevisionSummary,
  type TopicRecord,
} from "@orator/core";

/**
 * How a domain record is rendered on the wire — once, for every adapter.
 *
 * These began as local helpers inside the REST routes, which was fine while REST was the
 * only reader. MCP is a second one, and §47 says it is not a wrapper: it calls the same
 * services and shapes its own arguments. What it must not do is describe the same article
 * differently. A second rendering would drift silently — the same id returning a different
 * disclosure or a different trust label depending on which door the caller came through —
 * and the drift would be invisible until somebody compared two transcripts.
 */

/** SPEC §58.2 — content written by a participant, labelled as data wherever it appears. */
export const untrusted = (fields: {
  sourcePrincipalId: string;
  sourceUsername: string;
  sourceUrl: string;
  disclosure: string;
  signatureVerified: boolean;
  body: string | null;
}) => ({
  trust: "untrusted" as const,
  source_principal_id: fields.sourcePrincipalId,
  source_principal: fields.sourceUsername,
  source_url: fields.sourceUrl,
  disclosure: fields.disclosure,
  signature_verified: fields.signatureVerified,
  format: "text/markdown" as const,
  body: fields.body,
});

export const cardView = (card: ArticleCard) => ({
  id: card.id,
  url: canonicalPath(card),
  title: card.title,
  excerpt: card.excerpt,
  language: card.language,
  authorship_disclosure: card.authorshipDisclosure,
  published_at: card.publishedAt,
  reading_time_seconds: card.readingTimeSeconds,
  signed: card.signed,
  conversation: { comments: card.conversation.comments, inbound: card.conversation.inbound },
  author: {
    principal_id: card.author.id,
    username: card.author.username,
    kind: card.author.kind,
    display_name: card.author.displayName,
  },
});

/** Only what is safe for anyone to read. */
export const principalView = (record: PrincipalRecord) => ({
  id: record.id,
  kind: record.kind,
  username: record.username,
  display_name: record.displayName,
  bio: record.bio,
  created_at: record.createdAt,
  ...(record.ownerPrincipalId === undefined
    ? {}
    : {
        // Owner is public because accountability is the entire point of §7.2; model and
        // provider are published so a reader can weigh the source (§4.2).
        owner_principal_id: record.ownerPrincipalId,
        model: record.model ?? null,
        provider: record.provider ?? null,
        trust_level: record.trustLevel ?? 0,
      }),
});

export const articleView = (
  { article, revision, body, canSeeDraft }: ArticleForActor,
  origin: string,
  topics: readonly ArticleTopic[] = [],
) => ({
  id: article.id,
  url: urlFor(article.id),
  status: article.status,
  title: revision.title,
  excerpt: revision.excerpt,
  language: article.language,
  content: untrusted({
    sourcePrincipalId: article.authorPrincipalId,
    sourceUsername: `@${article.authorUsername}`,
    sourceUrl: `${origin}${urlFor(article.id)}`,
    disclosure: article.authorshipDisclosure,
    signatureVerified: revision.signature !== null,
    // Null when the body has been erased under §23.3; the record survives, the bytes do not.
    body,
  }),
  revision: {
    id: revision.id,
    content_hash: revision.contentHash,
    created_at: revision.createdAt,
    signed: revision.signature !== null,
  },
  author_principal_id: article.authorPrincipalId,
  published_at: article.publishedAt,
  indexable: article.indexable,
  /*
   * SPEC §22 — assigned by the platform, never claimed by the author.
   *
   * `source` is carried because the three values mean different things to a caller: `ai` is
   * the ordinary path, and `author` or `moderator` means somebody corrected it.
   */
  topics: topics.map((topic) => ({ slug: topic.slug, label: topic.label, source: topic.source })),
  // §34.3 — the value to send back as `If-Match`, and only to someone entitled to the
  // draft. `revision` above is the one being served; after an unpublished edit those are
  // two different revisions, and an author holding only the published id would be refused
  // on every conditional edit it made afterwards.
  ...(canSeeDraft ? { current_revision_id: article.currentRevisionId } : {}),
});

/**
 * What writing a revision returns (SPEC §8.4).
 *
 * The four fields §8.3 signs, plus the canonical string built from them. Returning the
 * string is not convenience: §8.3 exists because two implementations joining four values
 * into one line can disagree about the encoding, and a signature over the wrong encoding
 * fails with no indication of why. Nothing derived from a secret is in it.
 */
const signingFields = (articleId: string, revisionId: string, contentHash: string, createdAt: string) => ({
  revision_id: revisionId,
  content_hash: contentHash,
  created_at: createdAt,
  signing_input: revisionSigningInput({ articleId, revisionId, contentHash, createdAt }),
});

export const articleCreatedView = (article: ArticleSummary) => ({
  id: article.id,
  url: article.url,
  status: article.status,
  ...signingFields(article.id, article.revisionId, article.contentHash, article.createdAt),
});

export const revisionCreatedView = (revision: RevisionSummary) => ({
  ...signingFields(revision.articleId, revision.id, revision.contentHash, revision.createdAt),
  unchanged: revision.unchanged,
});

/** The receipt a write returns; the document is `commentView`. */
export const commentCreatedView = (comment: CommentSummary) => ({
  id: comment.id,
  article_id: comment.articleId,
  parent_comment_id: comment.parentCommentId,
  root_comment_id: comment.rootCommentId,
  depth: comment.depth,
  stance: comment.stance,
  created_at: comment.createdAt,
});

export const commentView = (comment: CommentRecord, origin: string) => {
  const removed = comment.status !== "visible";
  return {
    id: comment.id,
    article_id: comment.articleId,
    parent_comment_id: comment.parentCommentId,
    root_comment_id: comment.rootCommentId,
    depth: comment.depth,
    author: {
      principal_id: comment.authorPrincipalId,
      username: comment.authorUsername ?? null,
      kind: comment.authorKind ?? null,
    },
    stance: comment.stance,
    content: untrusted({
      sourcePrincipalId: comment.authorPrincipalId,
      sourceUsername: `@${comment.authorUsername ?? "unknown"}`,
      sourceUrl: `${origin}${urlFor(comment.articleId)}#c-${comment.id}`,
      disclosure: comment.authorKind === "agent" ? "ai_generated" : "human_authored",
      signatureVerified: false,
      // Withheld rather than the row hidden: the thread keeps its shape, and a reply to a
      // removed comment still reads as a reply to something (§23.2).
      body: removed ? null : comment.contentMarkdown,
    }),
    status: comment.status,
    created_at: comment.createdAt,
    edited_at: comment.editedAt,
  };
};

/**
 * The public address of a file, on the isolated origin (§57.4).
 *
 * Derived from the host that was asked rather than from configuration: the API is reached
 * as `api.orator.space` or `api-staging.orator.space`, and the media host is the same name
 * with the first label swapped. A configured value would be one more thing to get wrong
 * per environment, and getting it wrong here means serving user content from the origin
 * that holds the session.
 */
export function mediaUrl(requestUrl: string, id: string): string {
  const url = new URL(requestUrl);
  const labels = url.hostname.split(".");
  labels[0] = (labels[0] ?? "").replace(/^(api|mcp)/, "media");
  return `${url.protocol}//${labels.join(".")}${url.port === "" ? "" : `:${url.port}`}/${id}/original`;
}

export const mediaView = (media: MediaRecord, requestUrl: string) => ({
  id: media.id,
  owner_principal_id: media.ownerPrincipalId,
  status: media.status,
  kind: media.kind,
  content_type: media.contentType,
  byte_size: media.byteSize,
  checksum_sha256: media.checksumSha256,
  alt_text: media.altText,
  source: media.source,
  // Only a `ready` record has an address, because only a `ready` record has bytes (§21.1).
  url: media.status === "ready" ? mediaUrl(requestUrl, media.id) : null,
  upload_url:
    media.status === "pending"
      ? new URL(`/v1/media/${media.id}/content`, requestUrl).toString()
      : null,
  created_at: media.createdAt,
  finalized_at: media.finalizedAt,
});

export const edgeView = (edge: EdgeRecord) => ({
  id: edge.id,
  src_article_id: edge.srcArticleId,
  kind: edge.kind,
  dst_article_id: edge.dstArticleId,
  dst_uri: edge.dstUri,
  via_comment_id: edge.viaCommentId,
  note: edge.note,
  created_by_principal_id: edge.createdByPrincipalId,
  created_at: edge.createdAt,
});

export const eventView = (event: NewEvent) => ({
  id: event.id,
  type: event.type,
  actor_principal_id: event.actorPrincipalId,
  subject_type: event.subjectType,
  subject_id: event.subjectId,
  payload: event.payload,
  created_at: event.createdAt,
});

/** Public activity on one article: what happened and when, not what was said. */
export const activityView = (event: NewEvent) => ({
  id: event.id,
  type: event.type,
  actor_principal_id: event.actorPrincipalId,
  created_at: event.createdAt,
});

export const topicView = (topic: TopicRecord) => ({
  id: topic.id,
  slug: topic.slug,
  label: topic.label,
  description: topic.description,
  // §22.1 — the hierarchy is data rather than an address, so a client that wants to render
  // it has to be told; the slug alone cannot say what a topic sits under.
  parent: topic.parentSlug,
  // §22.1 — an archived topic still answers, and a caller building a picker needs to know
  // not to offer it.
  status: topic.status,
});

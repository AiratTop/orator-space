import type {
  ArticleCard,
  ArticleLink,
  ArticleRecord,
  ArticleView,
  AuthoredComment,
  AuthorSummary,
  Citation,
  Conversation,
  ConversationSignals,
  Disclosure,
  EdgeKind,
  FeedPage,
  FeedWindow,
  LinkedArticle,
  ReadingRepo,
  RevisionRecord,
  Stance,
  ThreadComment,
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

/**
 * The author columns, in one place, for every query that renders a byline (§49.4).
 *
 * A string rather than three copies, because the copies had already drifted: the article
 * projection selected `avatar_media_id` and the profile header and the comment thread did
 * not, so an uploaded picture appeared beside an article while the same person's own page
 * still drew the generated mark. The public read model names its columns — `SELECT p.*`
 * would hide an omission behind a shape that happens to be right — so the list lives once,
 * next to the row it fills.
 *
 * Every query interpolating it joins `principals p`, `agents ag`, and the owner as `owner`.
 * Exported for the topic listing, which builds its own card query in another file and was
 * the fourth copy.
 */
export const AUTHOR_COLUMNS = `
         p.id AS a_id, p.kind AS a_kind, p.username AS a_username,
         p.display_name AS a_display_name, p.bio AS a_bio, p.avatar_media_id AS a_avatar,
         ag.model AS a_model, ag.trust_level AS a_trust_level,
         owner.username AS a_owner_username, p.system_account AS a_system`;

/** The author columns, shared by every query that renders a byline (§49.4). */
interface AuthorRow {
  a_id: string;
  a_kind: string;
  a_username: string;
  a_display_name: string | null;
  a_bio: string | null;
  a_avatar: string | null;
  a_model: string | null;
  a_trust_level: number | null;
  a_owner_username: string | null;
  a_system: number | null;
}

interface RevisionHistoryRow extends AuthorRow {
  id: string;
  title: string;
  excerpt: string | null;
  content_hash: string;
  content_bytes: number;
  signature: string | null;
  created_at: string;
  published_at: string;
}

interface ViewRow extends AuthorRow {
  // article
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
  duplicate_of: string | null;
  featured_media_id: string | null;
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
  // signing key
  k_public_key: string | null;
  k_created_at: string | null;
  k_revoked_at: string | null;
  // conversation state — only on the single-article read, see CONVERSATION_VERSION
  conv_comments?: string;
  conv_comment_at?: string | null;
  conv_edges?: number;
  conv_edge_at?: string | null;
  // the two numbers a reader is shown; on every row, see SIGNALS
  sig_comments: number;
  sig_inbound: number;
}

/**
 * The two numbers on a card, and what they cost (SPEC §49.2, §84, ADR 0011).
 *
 * Two correlated subqueries on every row of a feed page, which is a cost this file
 * previously argued against paying: the note on `CONVERSATION_VERSION` says four subqueries
 * per card is precisely what §33.3 exists to avoid. That note was right about four and wrong
 * to generalise, and the reasoning is worth stating rather than quietly reversing.
 *
 * Both are equality seeks on an index that already exists — `ix_comments_article` and
 * `ix_edges_dst` — so each costs a b-tree descent against rows the page is about anyway,
 * twenty times per page, behind a thirty-second edge cache (§33.2). `feed.test.ts` asserts
 * the query plan says SEARCH rather than SCAN for both, so a future index change that turns
 * one into a table scan fails a test rather than a bill.
 *
 * The alternative was `article_stats`, which exists for exactly this and would make the feed
 * one join on a primary key. It is not used because nothing populates those two columns yet,
 * and a counter maintained by an event handler is a second source of truth that drifts
 * whenever a delivery is lost. When a query plan says these seeks are the feed's cost, the
 * counters move to `article_stats` and this becomes a join — the shape of the read model
 * does not change either way.
 */
const SIGNALS = `
    (SELECT COUNT(*) FROM comments c
      WHERE c.article_id = a.id AND c.status = 'visible') AS sig_comments,
    (SELECT COUNT(*) FROM edges e WHERE e.dst_article_id = a.id) AS sig_inbound`;

/**
 * One query for the whole page.
 *
 * Four joins rather than four round trips. D1 charges per statement and the article page is
 * the hottest read in the system; splitting this would multiply the cost of the one request
 * §33.3 assumes is cheap. The signing key is joined in for the same reason — verification
 * needs the public key, and fetching it separately would double the cost of provenance.
 */
const VIEW_COLUMNS = `
         a.id, a.author_principal_id, a.status, a.visibility,
         a.current_revision_id, a.published_revision_id, a.language, a.translation_group_id,
         a.authorship_disclosure, a.indexable, a.canonical_url, a.duplicate_of,
         a.featured_media_id,
         a.created_at, a.updated_at, a.published_at, a.removed_at,
         r.id AS r_id, r.parent_revision_id AS r_parent, r.title AS r_title,
         r.excerpt AS r_excerpt, r.content_ref AS r_content_ref, r.content_hash AS r_content_hash,
         r.content_bytes AS r_content_bytes, r.reading_time_seconds AS r_reading_time,
         r.metadata_json AS r_metadata, r.created_by_principal_id AS r_created_by,
         r.signature AS r_signature, r.signature_key_id AS r_signature_key_id,
         r.created_at AS r_created_at,
${AUTHOR_COLUMNS},
         k.public_key AS k_public_key, k.created_at AS k_created_at, k.revoked_at AS k_revoked_at,
         ${SIGNALS}`;

const VIEW_FROM = `
    FROM articles a
    JOIN revisions r  ON r.id = a.published_revision_id
    JOIN principals p ON p.id = a.author_principal_id
    LEFT JOIN agents ag        ON ag.principal_id = p.id
    LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
    LEFT JOIN agent_keys k     ON k.id = r.signature_key_id`;

const VIEW_SELECT = `SELECT ${VIEW_COLUMNS} ${VIEW_FROM}`;

/**
 * The card projection, for a repository that joins something else onto it.
 *
 * Exported rather than copied, because a second copy of forty columns is a second place for
 * a card to gain a field and not gain it. The caller appends its own `JOIN` and `WHERE`.
 */
export const cardSelect = (): string => VIEW_SELECT;
export const toCardRow = (row: unknown): ArticleCard => toCard(row as ViewRow);

const PUBLIC = `a.status = 'published' AND a.visibility = 'public' AND p.status = 'active'`;

/*
 * §66.7 — the canary is kept out of the feed, not out of existence.
 *
 * The first version of this put `p.system_account = 0` into `PUBLIC`, which every read
 * shares, and the deep check immediately failed its own `indexed` and `public` steps: the
 * article it had just published was unreadable at its own URL and absent from the search
 * index it was waiting on. §66.7 requires the check to read the article back and to wait for
 * it to appear in the index, so those two paths must see it.
 *
 * What §66.7 actually asks to exclude is what a reader encounters without asking for it —
 * a feed, a profile, a search result, the sitemap. Reaching a canary by its own id requires
 * having the id, which only the check has, and only for the seconds before it removes it.
 */
const NOT_SYSTEM = `p.system_account = 0`;

/*
 * §60.1, §13.1 — a duplicate leaves the surfaces the platform curates and keeps its address.
 *
 * The same shape as `NOT_SYSTEM` above and for the same reason: it is applied to what a
 * reader encounters without asking for it — the feed, a topic listing, a search result — and
 * not to `findPublished`, so `/p/{id}` still answers, the API still returns it, and its
 * citations still resolve.
 *
 * Deliberately not applied to `listByAuthor`. That listing is a record of what a person
 * published rather than a recommendation the platform is making, and it is where they would
 * go to fix it; a duplicate vanishing from there too would be the platform hiding somebody's
 * work from them.
 *
 * This is a listing decision of the same class as `indexable` (§50.3), not a moderation
 * action: nothing is removed, the pointer is recorded, and §60.1's report reaches the queue
 * so a person can reverse it.
 */
const NOT_DUPLICATE = `a.duplicate_of IS NULL`;

/**
 * The article page's other half, reduced to four numbers (SPEC §33.2, §33.3).
 *
 * The page renders the conversation, so the page's validator has to cover it — otherwise a
 * cached copy revalidates against a content hash that did not change and keeps serving a
 * chain that is three links short, for as long as `stale-while-revalidate` runs. These are
 * counts and maxima rather than a digest of the rows, because revalidation must not read
 * the rows: comments are inserted and change status but are never edited, so a total, a
 * visible count and the newest timestamp separate every state the page can render; edges
 * are only inserted and deleted, so a count and a timestamp do.
 *
 * Appended to the single-article read alone. The feed uses the same joins and needs none of
 * this, and four correlated subqueries per card is precisely the cost §33.3 exists to avoid.
 */
const CONVERSATION_VERSION = `,
    (SELECT COUNT(*) || '.' || COALESCE(SUM(c.status = 'visible'), 0)
       FROM comments c WHERE c.article_id = a.id) AS conv_comments,
    (SELECT MAX(c.created_at) FROM comments c WHERE c.article_id = a.id) AS conv_comment_at,
    (SELECT COUNT(*) FROM edges e
      WHERE e.src_article_id = a.id OR e.dst_article_id = a.id) AS conv_edges,
    (SELECT MAX(e.created_at) FROM edges e
      WHERE e.src_article_id = a.id OR e.dst_article_id = a.id) AS conv_edge_at`;

/**
 * The thread, with each author joined in (SPEC §17, §49.4).
 *
 * Ascending by id, which is creation order (§12.2), so the thread reads the way it was
 * written and a reply always follows the comment it answers. Removed comments stay in the
 * list: the caller withholds the body and keeps the row, because a hole in a thread makes
 * the replies below it unreadable (§23.2).
 */
const THREAD_SELECT = `
  SELECT c.id, c.parent_comment_id, c.depth, c.stance, c.content_markdown, c.status,
         c.created_at,
${AUTHOR_COLUMNS}
    FROM comments c
    JOIN principals p ON p.id = c.author_principal_id
    LEFT JOIN agents ag        ON ag.principal_id = p.id
    LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
   WHERE c.article_id = ?
   ORDER BY c.id ASC
   LIMIT ?`;

interface ThreadRow extends AuthorRow {
  id: string;
  status: string;
  created_at: string;
  parent_comment_id: string | null;
  depth: number;
  stance: string | null;
  content_markdown: string;
}

/**
 * Edges in one direction, with the article at the far end resolved.
 *
 * The join is `LEFT` and the visibility filter sits in the ON clause rather than the WHERE:
 * an edge pointing at a draft, a removed article or an external URL must still count as an
 * edge — it is simply not a link a reader can follow. Dropping those rows would quietly
 * shrink the graph whenever a target was unpublished.
 *
 * One hop, never two (§18). A page shows what points here and what this points at, and
 * nothing about what points at those.
 */
const linkSelect = (direction: "inbound" | "outbound") => {
  const [mine, theirs] =
    direction === "inbound"
      ? ["e.dst_article_id", "e.src_article_id"]
      : ["e.src_article_id", "e.dst_article_id"];
  return `
  SELECT e.id, e.kind, e.note, e.created_at, e.dst_uri,
         t.id AS t_id, tr.title AS t_title,
         tp.username AS t_username, tp.kind AS t_kind
    FROM edges e
    LEFT JOIN articles t    ON t.id = ${theirs}
                            AND t.status = 'published' AND t.visibility = 'public'
    LEFT JOIN revisions tr  ON tr.id = t.published_revision_id
    LEFT JOIN principals tp ON tp.id = t.author_principal_id AND tp.status = 'active'
   WHERE ${mine} = ?
   ORDER BY e.id ASC
   LIMIT ?`;
};

interface LinkRow {
  id: string;
  kind: string;
  note: string | null;
  created_at: string;
  dst_uri: string | null;
  t_id: string | null;
  t_title: string | null;
  t_username: string | null;
  t_kind: string | null;
}

const toLink = (row: LinkRow): ArticleLink => ({
  id: row.id as OratorId,
  kind: row.kind as EdgeKind,
  note: row.note,
  createdAt: row.created_at,
  article:
    row.t_id === null || row.t_title === null || row.t_username === null
      ? null
      : {
          id: row.t_id as OratorId,
          title: row.t_title,
          authorUsername: row.t_username,
          authorKind: (row.t_kind ?? "human") as "human" | "agent",
        },
  uri: row.dst_uri,
});

const toThreadComment = (row: ThreadRow): ThreadComment => ({
  id: row.id as OratorId,
  parentCommentId: row.parent_comment_id as OratorId | null,
  depth: row.depth,
  stance: row.stance as Stance | null,
  body: row.status === "visible" ? row.content_markdown : null,
  status: row.status as ThreadComment["status"],
  createdAt: row.created_at,
  author: toAuthor(row),
});

/** One hop each way, and no more rows than a page can honestly render (§18). */
const MAX_LINKS = 50;

/**
 * A principal's comments, with the article each was left on (SPEC §49.2).
 *
 * The join to `articles` is inner rather than left, unlike the one in `linkSelect`. An edge
 * whose target has gone is still an edge and §49.3 keeps the row; a comment whose article a
 * reader cannot open has nothing left to be a comment *on*, and rendering it would put a
 * fragment of an argument on the page with no way to see what it answered.
 *
 * Keyed by id alone. An Orator id is time-ordered (§12.2), so it is both the sort key and a
 * unique one — which is why this page carries a plain id where the feed carries an encoded
 * `(published_at, id)` pair and needs the pair to break ties.
 */
const AUTHORED_COMMENTS = `
  SELECT c.id, c.stance, c.content_markdown, c.status, c.created_at,
         t.id AS t_id, tr.title AS t_title, tp.username AS t_username
    FROM comments c
    JOIN articles t    ON t.id = c.article_id
                       AND t.status = 'published' AND t.visibility = 'public'
    JOIN revisions tr  ON tr.id = t.published_revision_id
    JOIN principals tp ON tp.id = t.author_principal_id AND tp.status = 'active'
   WHERE c.author_principal_id = ? AND tp.system_account = 0`;

/**
 * What the network said back about this principal's work (SPEC §18, §84).
 *
 * Both ends resolved and both required: an edge is listed here only when a reader can open
 * the article making the claim and the article it is made about. An external URI has no
 * source article and cannot appear — nothing on the open web points *into* the graph through
 * an edge row, so there is no case being dropped.
 *
 * Self-citation is excluded. An author citing their own earlier article is ordinary and
 * useful on the article page, where it is a claim about two texts; on a profile tab whose
 * subject is what other people made of the work, it is the one number the subject can move
 * on their own.
 */
const CITATIONS_OF = `
  SELECT e.id, e.kind, e.note, e.created_at,
         s.id AS s_id, sr.title AS s_title, sp.username AS s_username, sp.kind AS s_kind,
         t.id AS t_id, tr.title AS t_title, tp.username AS t_username, tp.kind AS t_kind
    FROM edges e
    JOIN articles t    ON t.id = e.dst_article_id
                       AND t.status = 'published' AND t.visibility = 'public'
    JOIN revisions tr  ON tr.id = t.published_revision_id
    JOIN principals tp ON tp.id = t.author_principal_id AND tp.status = 'active'
    JOIN articles s    ON s.id = e.src_article_id
                       AND s.status = 'published' AND s.visibility = 'public'
    JOIN revisions sr  ON sr.id = s.published_revision_id
    JOIN principals sp ON sp.id = s.author_principal_id AND sp.status = 'active'
   WHERE t.author_principal_id = ? AND s.author_principal_id <> ?
     AND sp.system_account = 0`;

interface AuthoredCommentRow {
  id: string;
  stance: string | null;
  content_markdown: string;
  status: string;
  created_at: string;
  t_id: string;
  t_title: string;
  t_username: string;
}

interface CitationRow {
  id: string;
  kind: string;
  note: string | null;
  created_at: string;
  s_id: string;
  s_title: string;
  s_username: string;
  s_kind: string;
  t_id: string;
  t_title: string;
  t_username: string;
  t_kind: string;
}

const linkedArticle = (id: string, title: string, username: string, kind: string): LinkedArticle => ({
  id: id as OratorId,
  title,
  authorUsername: username,
  authorKind: (kind === "agent" ? "agent" : "human") as "human" | "agent",
});

const toAuthor = (row: AuthorRow): AuthorSummary => ({
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
});

function toView(row: ViewRow): ArticleView {
  const article: ArticleRecord = {
    id: row.id as OratorId,
    authorPrincipalId: row.author_principal_id as OratorId,
    authorUsername: row.a_username,
    status: row.status as ArticleRecord["status"],
    visibility: row.visibility as ArticleRecord["visibility"],
    currentRevisionId: row.current_revision_id as OratorId | null,
    publishedRevisionId: row.published_revision_id as OratorId | null,
    language: row.language,
    translationGroupId: row.translation_group_id,
    authorshipDisclosure: row.authorship_disclosure as Disclosure,
    indexable: row.indexable === 1,
    canonicalUrl: row.canonical_url,
    duplicateOf: (row.duplicate_of ?? null) as OratorId | null,
    featuredMediaId: (row.featured_media_id ?? null) as OratorId | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    removedAt: row.removed_at,
    // The read model only ever sees published articles, so this is always null here.
    removalSource: null,
    // The public page does not act on the moderation verdict: what it acts on is
    // `indexable`, which §50.3 derives from the verdict and from three other conditions.
    moderationState: "unchecked",
    moderationVerdict: null,
    moderatedAt: null,
    simhash: null,
    indexableReason: null,
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

  const changedAt = [row.conv_comment_at ?? null, row.conv_edge_at ?? null]
    .filter((at): at is string => at !== null)
    .sort()
    .pop();

  return {
    article,
    revision,
    author: toAuthor(row),
    conversation: {
      token: `${row.conv_comments ?? "0.0"}:${row.conv_edges ?? 0}`,
      changedAt: changedAt ?? null,
    },
    signals: signalsOf(row),
    signingKey:
      row.k_public_key === null || row.k_created_at === null
        ? null
        : { publicKey: row.k_public_key, createdAt: row.k_created_at, revokedAt: row.k_revoked_at },
  };
}

const signalsOf = (row: { sig_comments: number; sig_inbound: number }): ConversationSignals => ({
  comments: row.sig_comments,
  inbound: row.sig_inbound,
});

const toCard = (row: ViewRow): ArticleCard => ({
  id: row.id as OratorId,
  title: row.r_title,
  excerpt: row.r_excerpt,
  language: row.language,
  authorshipDisclosure: row.authorship_disclosure as Disclosure,
  publishedAt: row.published_at ?? row.r_created_at,
  readingTimeSeconds: row.r_reading_time,
  contentHash: row.r_content_hash,
  signed: row.r_signature !== null,
  author: toAuthor(row),
  conversation: signalsOf(row),
});

/**
 * Keyset pagination over `(published_at DESC, id DESC)`.
 *
 * Not OFFSET: an offset re-reads every skipped row and, on a feed that changes while it is
 * being paged, silently repeats and drops articles. The comparison is on the pair because
 * `published_at` is not unique — two articles published in the same second would otherwise
 * make the page boundary a coin toss (§12.2).
 */
/**
 * The keyset, in both directions (SPEC §44.2).
 *
 * `id` breaks the tie, because two articles published in the same millisecond would
 * otherwise make the cursor ambiguous and skip one of them.
 */
const OLDER = `(a.published_at < ? OR (a.published_at = ? AND a.id < ?))`;
const NEWER = `(a.published_at > ? OR (a.published_at = ? AND a.id > ?))`;

const cursorOf = (card: ArticleCard): FeedCursor => ({ publishedAt: card.publishedAt, id: card.id });

/**
 * Turns the rows into a page, whichever direction they were read in.
 *
 * Going backwards, the query asks for ascending rows and this reverses them, so the page is
 * always newest-first however the reader arrived at it. The extra row is the same trick in
 * both directions: it says whether there is more that way without a second query.
 */
function toPage(rows: ViewRow[], limit: number, direction: "older" | "newer"): FeedPage {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(toCard);
  const cards = direction === "older" ? page : [...page].reverse();

  const first = cards[0];
  const last = cards[cards.length - 1];
  if (first === undefined || last === undefined) return { cards, next: null, previous: null };

  return direction === "older"
    ? { cards, next: hasMore ? cursorOf(last) : null, previous: null }
    : // We arrived here from something older, so `next` is not in question.
      { cards, next: cursorOf(last), previous: hasMore ? cursorOf(first) : null };
}

export function createReadingRepo(db: D1Database): ReadingRepo {
  const feed = async (where: string, binds: unknown[], limit: number, window: FeedWindow) => {
    // `before` wins if a caller supplies both, which is a caller error rather than a state.
    const cursor = window.before ?? window.after;
    const direction = window.before !== null || window.after === null ? "older" : "newer";
    const keyset = cursor === null ? "" : ` AND ${direction === "older" ? OLDER : NEWER}`;
    const cursorBinds = cursor === null ? [] : [cursor.publishedAt, cursor.publishedAt, cursor.id];
    const order = direction === "older" ? "DESC" : "ASC";

    const { results } = await db
      .prepare(
        `${VIEW_SELECT} WHERE ${PUBLIC} AND ${where}${keyset}
          ORDER BY a.published_at ${order}, a.id ${order} LIMIT ?`,
      )
      .bind(...binds, ...cursorBinds, limit + 1)
      .all<ViewRow>();

    const page = toPage(results, limit, direction);
    // A page reached through a cursor always has something newer, whether or not this
    // query looked that way. Without it, "newer" disappears the moment a reader steps back.
    return page.previous === null && window.before !== null && page.cards[0] !== undefined
      ? { ...page, previous: cursorOf(page.cards[0]) }
      : page;
  };

  return {
    async findPublished(id) {
      const row = await db
        .prepare(
          `SELECT ${VIEW_COLUMNS}${CONVERSATION_VERSION} ${VIEW_FROM} WHERE a.id = ? AND ${PUBLIC}`,
        )
        .bind(id)
        .first<ViewRow>();
      return row === null ? null : toView(row);
    },

    listLatest(limit, window) {
      return feed(`${NOT_SYSTEM} AND ${NOT_DUPLICATE} AND a.published_at IS NOT NULL`, [], limit, window);
    },

    listByAuthor(principalId, limit, window) {
      // Also filtered: a profile page is somewhere a reader arrives without asking for it.
      return feed(`${NOT_SYSTEM} AND a.author_principal_id = ?`, [principalId], limit, window);
    },

    /**
     * Articles sharing this one's topics (SPEC §22, §49.3).
     *
     * The cheap half of "articles like this one", and the reason §22's classification was
     * built before a vector store (§38.2): topic overlap gives a reader a recommendation
     * with a reason they can read — *also in Inference and serving* — where a vector
     * distance gives a list and no account of itself.
     *
     * Ordered by how many topics are shared and then by recency. Two shared topics is a
     * stronger claim than one, and among equals the newer article is the better offer.
     */
    async listRelated(articleId, limit) {
      const { results } = await db
        .prepare(
          `${VIEW_SELECT}
             JOIN (
               SELECT other.article_id AS id, COUNT(*) AS shared
                 FROM article_topics other
                WHERE other.topic_id IN (SELECT topic_id FROM article_topics WHERE article_id = ?1)
                  AND other.article_id <> ?1
                GROUP BY other.article_id
             ) m ON m.id = a.id
            WHERE ${PUBLIC} AND ${NOT_SYSTEM} AND ${NOT_DUPLICATE} AND a.published_at IS NOT NULL
            ORDER BY m.shared DESC, a.published_at DESC, a.id DESC
            LIMIT ?2`,
        )
        .bind(articleId, limit)
        .all<ViewRow>();
      return results.map(toCard);
    },

    async countPublished() {
      // Served by the partial index on `published_at`, so it is a scan of the published
      // rows rather than of the table — the same index the feed itself uses.
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM articles a
             JOIN principals p ON p.id = a.author_principal_id
            WHERE ${PUBLIC} AND ${NOT_SYSTEM} AND ${NOT_DUPLICATE} AND a.published_at IS NOT NULL`,
        )
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    /**
     * The agents one human is accountable for (SPEC §7.2).
     *
     * Two statements in one batch: the page, and how many there are altogether. The count is
     * separate rather than inferred from a page that came back short, because "showing all
     * twelve" and "showing twelve of thirty" are different sentences and the page has to
     * pick one.
     *
     * Ordered by what each has published, then by name. A reader scanning this is deciding
     * which agent to open, and the one with forty articles is a better answer than the one
     * that happens to sort first.
     *
     * `system_account = 0`: §66.7 keeps the canary out of what a reader meets without asking,
     * and its owner's profile is exactly that.
     */
    /**
     * SPEC §22 — an article's topics, ordered so the primary one reads first.
     *
     * Confidence descending, then slug, which is §22.2's derived primary: the highest
     * confidence, ties broken by id. A stored column would be a second place for the same
     * fact to be wrong.
     */
    async topicsOf(articleId) {
      const { results } = await db
        .prepare(
          `SELECT t.slug, t.label, at.source
             FROM article_topics at
             JOIN topics t ON t.id = at.topic_id
            WHERE at.article_id = ?
            ORDER BY at.confidence DESC NULLS LAST, t.slug ASC`,
        )
        .bind(articleId)
        .all<{ slug: string; label: string; source: string }>();
      return results.map((row) => ({
        slug: row.slug,
        label: row.label,
        source: row.source as "author" | "ai" | "moderator",
      }));
    },

    async topicsForArticles(articleIds) {
      if (articleIds.length === 0) return new Map();
      const placeholders = articleIds.map(() => "?").join(", ");
      const { results } = await db
        .prepare(
          `SELECT at.article_id, t.slug, t.label, at.source
             FROM article_topics at
             JOIN topics t ON t.id = at.topic_id
            WHERE at.article_id IN (${placeholders})
            ORDER BY at.article_id, at.confidence DESC NULLS LAST, t.slug ASC`,
        )
        .bind(...articleIds)
        .all<{ article_id: string; slug: string; label: string; source: string }>();

      const grouped = new Map<string, { slug: string; label: string; source: "author" | "ai" | "moderator" }[]>();
      for (const row of results) {
        const list = grouped.get(row.article_id) ?? [];
        list.push({ slug: row.slug, label: row.label, source: row.source as "author" | "ai" | "moderator" });
        grouped.set(row.article_id, list);
      }
      return grouped;
    },

    async listAgentsOf(ownerPrincipalId, limit) {
      const where = `ag.owner_principal_id = ? AND p.status = 'active' AND p.system_account = 0`;
      const batched = await db.batch([
        db
          .prepare(
            `SELECT p.id, p.username, p.display_name, ag.model,
                    (SELECT COUNT(*) FROM articles a
                      WHERE a.author_principal_id = p.id
                        AND a.status = 'published' AND a.visibility = 'public') AS articles
               FROM agents ag
               JOIN principals p ON p.id = ag.principal_id
              WHERE ${where}
              ORDER BY articles DESC, p.username ASC
              LIMIT ?`,
          )
          .bind(ownerPrincipalId, limit),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM agents ag
               JOIN principals p ON p.id = ag.principal_id
              WHERE ${where}`,
          )
          .bind(ownerPrincipalId),
      ]);

      interface AgentRow {
        id: string;
        username: string;
        display_name: string | null;
        model: string | null;
        articles: number;
      }
      const rows = (batched[0]?.results ?? []) as AgentRow[];
      return {
        agents: rows.map((row) => ({
          id: row.id as OratorId,
          username: row.username,
          displayName: row.display_name,
          model: row.model,
          articles: row.articles,
        })),
        total: ((batched[1]?.results ?? []) as { n: number }[])[0]?.n ?? 0,
      };
    },

    /**
     * Three statements in one batch, which is one round trip.
     *
     * Not one query with unions: the three answer different questions and would need
     * padding columns to share a shape, and D1's batch already collapses the round trip
     * that made joining attractive in the first place.
     */
    async loadConversation(articleId, limit) {
      const batched = await db.batch([
        db.prepare(THREAD_SELECT).bind(articleId, limit + 1),
        db.prepare(linkSelect("inbound")).bind(articleId, MAX_LINKS),
        db.prepare(linkSelect("outbound")).bind(articleId, MAX_LINKS),
      ]);
      const rowsOf = <T>(index: number): T[] => (batched[index]?.results ?? []) as T[];

      // One row more than asked for is how truncation is known without a second count.
      const thread = rowsOf<ThreadRow>(0);
      return {
        comments: thread.slice(0, limit).map(toThreadComment),
        inbound: rowsOf<LinkRow>(1).map(toLink),
        outbound: rowsOf<LinkRow>(2).map(toLink),
        truncated: thread.length > limit,
      } satisfies Conversation;
    },

    /**
     * One page of a profile tab, keyed by id.
     *
     * `before` is exclusive and the order is descending, so the extra row read is how "is
     * there more" is answered without a second count — the same trick the feed uses, with a
     * simpler key.
     */
    async listCommentsByAuthor(principalId, limit, before) {
      const keyset = before === null ? "" : " AND c.id < ?";
      const binds = before === null ? [principalId] : [principalId, before];
      const { results } = await db
        .prepare(`${AUTHORED_COMMENTS}${keyset} ORDER BY c.id DESC LIMIT ?`)
        .bind(...binds, limit + 1)
        .all<AuthoredCommentRow>();

      const rows = results.slice(0, limit);
      return {
        comments: rows.map((row) => ({
          id: row.id as OratorId,
          stance: row.stance as Stance | null,
          // Withheld exactly as in a thread (§23.2): the row is the record that something
          // was said here, and the body is what moderation took away.
          body: row.status === "visible" ? row.content_markdown : null,
          status: row.status as AuthoredComment["status"],
          createdAt: row.created_at,
          article: {
            id: row.t_id as OratorId,
            title: row.t_title,
            authorUsername: row.t_username,
          },
        })),
        next: results.length > limit ? (rows[rows.length - 1]?.id ?? null) : null,
      };
    },

    async listCitationsOf(principalId, limit, before) {
      const keyset = before === null ? "" : " AND e.id < ?";
      const binds = before === null ? [principalId, principalId] : [principalId, principalId, before];
      const { results } = await db
        .prepare(`${CITATIONS_OF}${keyset} ORDER BY e.id DESC LIMIT ?`)
        .bind(...binds, limit + 1)
        .all<CitationRow>();

      const rows = results.slice(0, limit);
      return {
        citations: rows.map(
          (row): Citation => ({
            id: row.id as OratorId,
            kind: row.kind as EdgeKind,
            note: row.note,
            createdAt: row.created_at,
            source: linkedArticle(row.s_id, row.s_title, row.s_username, row.s_kind),
            target: linkedArticle(row.t_id, row.t_title, row.t_username, row.t_kind),
          }),
        ),
        next: results.length > limit ? (rows[rows.length - 1]?.id ?? null) : null,
      };
    },

    /**
     * The three numbers on the tabs, in one round trip.
     *
     * A count next to a tab is what makes a tab worth having — a reader should be able to
     * see that a profile has forty comments and no citations without clicking twice. Batched
     * rather than sequenced, because D1 charges per statement and these are three cheap
     * counts, not three queries worth waiting on in turn.
     */
    async countProfile(principalId) {
      const batched = await db.batch<{ n: number }>([
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM articles a
               JOIN principals p ON p.id = a.author_principal_id
              WHERE ${PUBLIC} AND a.author_principal_id = ?`,
          )
          .bind(principalId),
        db.prepare(`SELECT COUNT(*) AS n FROM (${AUTHORED_COMMENTS})`).bind(principalId),
        db.prepare(`SELECT COUNT(*) AS n FROM (${CITATIONS_OF})`).bind(principalId, principalId),
      ]);
      const n = (index: number): number => batched[index]?.results?.[0]?.n ?? 0;
      return { articles: n(0), comments: n(1), citations: n(2) };
    },

    /**
     * §66.7 — a profile is on the list of things a canary does not appear in.
     *
     * Its two callers are the profile page and principal search, and neither needs it: the
     * deep check authenticates as the canary and never looks itself up by name. Unlike an
     * article id, a canary's username is stable and guessable, so "reaching it requires
     * having the id" — the argument that keeps the article's own URL open — does not apply.
     */
    /**
     * §16.3, §49.2 — the versions of one article that were ever public.
     *
     * The author of a revision is joined in rather than assumed to be the article's author:
     * §43.2 lets an owner write a revision of their agent's article, and a history that
     * attributed every version to the article's author would state something false about who
     * changed what.
     */
    async listPublishedRevisions(articleId, limit) {
      const { results } = await db
        .prepare(
          `SELECT r.id, r.title, r.excerpt, r.content_hash, r.content_bytes, r.signature,
                  r.created_at, r.published_at,
                  ${AUTHOR_COLUMNS}
             FROM revisions r
             JOIN principals p ON p.id = r.created_by_principal_id
             LEFT JOIN agents ag        ON ag.principal_id = p.id
             LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
            WHERE r.article_id = ? AND r.published_at IS NOT NULL
            ORDER BY r.published_at DESC, r.id DESC
            LIMIT ?`,
        )
        .bind(articleId, limit)
        .all<RevisionHistoryRow>();

      return results.map((row) => ({
        id: row.id as OratorId,
        title: row.title,
        excerpt: row.excerpt,
        contentHash: row.content_hash,
        contentBytes: row.content_bytes,
        createdBy: toAuthor(row),
        signed: row.signature !== null,
        createdAt: row.created_at,
        publishedAt: row.published_at,
      }));
    },

    async findPrincipalByUsername(username) {
      const row = await db
        .prepare(
          `SELECT ${AUTHOR_COLUMNS}
             FROM principals p
             LEFT JOIN agents ag        ON ag.principal_id = p.id
             LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
            WHERE p.username = ? AND p.status = 'active' AND ${NOT_SYSTEM}`,
        )
        .bind(username)
        .first<AuthorRow>();
      return row === null ? null : toAuthor(row);
    },
  };
}

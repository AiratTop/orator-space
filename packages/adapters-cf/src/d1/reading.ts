import type {
  ArticleCard,
  ArticleLink,
  ArticleRecord,
  ArticleView,
  AuthorSummary,
  Conversation,
  Disclosure,
  EdgeKind,
  FeedPage,
  FeedWindow,
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

/** The author columns, shared by every query that renders a byline (§49.4). */
interface AuthorRow {
  a_id: string;
  a_kind: string;
  a_username: string;
  a_display_name: string | null;
  a_bio: string | null;
  a_model: string | null;
  a_trust_level: number | null;
  a_owner_username: string | null;
  a_system: number | null;
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
}

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
         owner.username AS a_owner_username, p.system_account AS a_system,
         k.public_key AS k_public_key, k.created_at AS k_created_at, k.revoked_at AS k_revoked_at`;

const VIEW_FROM = `
    FROM articles a
    JOIN revisions r  ON r.id = a.published_revision_id
    JOIN principals p ON p.id = a.author_principal_id
    LEFT JOIN agents ag        ON ag.principal_id = p.id
    LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
    LEFT JOIN agent_keys k     ON k.id = r.signature_key_id`;

const VIEW_SELECT = `SELECT ${VIEW_COLUMNS} ${VIEW_FROM}`;

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
         p.id AS a_id, p.kind AS a_kind, p.username AS a_username,
         p.display_name AS a_display_name, p.bio AS a_bio,
         ag.model AS a_model, ag.trust_level AS a_trust_level,
         owner.username AS a_owner_username
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

const toAuthor = (row: AuthorRow): AuthorSummary => ({
  id: row.a_id as OratorId,
  kind: row.a_kind as "human" | "agent",
  username: row.a_username,
  displayName: row.a_display_name,
  bio: row.a_bio,
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
    signingKey:
      row.k_public_key === null || row.k_created_at === null
        ? null
        : { publicKey: row.k_public_key, createdAt: row.k_created_at, revokedAt: row.k_revoked_at },
  };
}

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
      return feed(`${NOT_SYSTEM} AND a.published_at IS NOT NULL`, [], limit, window);
    },

    listByAuthor(principalId, limit, window) {
      // Also filtered: a profile page is somewhere a reader arrives without asking for it.
      return feed(`${NOT_SYSTEM} AND a.author_principal_id = ?`, [principalId], limit, window);
    },

    async countPublished() {
      // Served by the partial index on `published_at`, so it is a scan of the published
      // rows rather than of the table — the same index the feed itself uses.
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM articles a
             JOIN principals p ON p.id = a.author_principal_id
            WHERE ${PUBLIC} AND ${NOT_SYSTEM} AND a.published_at IS NOT NULL`,
        )
        .first<{ n: number }>();
      return row?.n ?? 0;
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

    async findPrincipalByUsername(username) {
      const row = await db
        .prepare(
          `SELECT p.id AS a_id, p.kind AS a_kind, p.username AS a_username,
                  p.display_name AS a_display_name, p.bio AS a_bio,
                  ag.model AS a_model, ag.trust_level AS a_trust_level,
                  owner.username AS a_owner_username, p.system_account AS a_system
             FROM principals p
             LEFT JOIN agents ag        ON ag.principal_id = p.id
             LEFT JOIN principals owner ON owner.id = ag.owner_principal_id
            WHERE p.username = ? AND p.status = 'active'`,
        )
        .bind(username)
        .first<AuthorRow>();
      return row === null ? null : toAuthor(row);
    },
  };
}

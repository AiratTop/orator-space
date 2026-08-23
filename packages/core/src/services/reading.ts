import { SCHEMA_VERSION, type FeedCursor, type OratorId } from "@orator/protocol";
import { canonicalPath } from "../articles/urls.js";
import { stripInvisible } from "../text/invisible.js";
import { keyValidAt, revisionSigningInput, verifySignature } from "../identity/keys.js";
import type {
  ArticleView,
  AuthoredCommentPage,
  CitationPage,
  Conversation,
  FeedPage,
  FeedWindow,
  OperatedAgents,
  ProfileCounts,
} from "../ports/reading.js";
import { fail, ok, type Ports, type Result } from "./context.js";

/**
 * Public reading (SPEC §48, §49, §33).
 *
 * The read path is split into three steps that are deliberately not one call:
 *
 *   1. `loadArticle`  — D1 only. Enough to answer a conditional request.
 *   2. `verifyProvenance` — one Ed25519 verification, only when something is rendered.
 *   3. `loadBody`     — the R2 read.
 *
 * §33.3 is the reason. Correctness of the cache comes from revalidation, which means a
 * short `s-maxage` and a great many `If-None-Match` requests. Each of those must cost one
 * indexed D1 query and nothing else — no object read, no signature check. Fusing the steps
 * would work and would quietly make the caching strategy expensive.
 */

/**
 * What reading needs, and nothing more.
 *
 * Narrower than `Ports` on purpose. The public web is a read-only surface: it has no queue
 * binding, issues no tokens and writes nothing, so requiring it to assemble a full `Ports`
 * would mean building adapters for capabilities it must not have. The type is the
 * enforcement — a write from a page would not compile.
 */
export type ReadingPorts = Pick<Ports, "reading" | "content">;

export interface PublicArticle {
  view: ArticleView;
  /** SPEC §33.2 — the ETag is the revision's content hash, already in D1. */
  etag: string;
  lastModified: string;
  canonicalPath: string;
  /**
   * The validator for the HTML page, which is a larger entity than the revision.
   *
   * §33.2 wrote the ETag as the revision's `content_hash`, and that was the whole of the
   * page until the page began rendering the conversation (§76). It is not any more: a
   * challenge, a reply and a citation change what the page says while the content hash
   * stands still, and a cached copy that revalidates on the hash alone keeps serving a
   * chain three links short for as long as `stale-while-revalidate` runs — a day.
   *
   * The `.md` and `.json` representations (§48) are the revision and nothing else, so they
   * keep `etag`. Two validators because there are two entities, not as a hedge.
   */
  pageEtag: string;
  /** The page's own `Last-Modified`: the newer of the revision and the conversation. */
  pageLastModified: string;
}

/**
 * What can be said about who wrote this.
 *
 * Four states, not a boolean. "Unsigned" is an ordinary outcome — a human publishing from
 * the web has no agent key — while "invalid" means someone asserted authorship and the
 * assertion failed, which is a different thing entirely and must never render as the same
 * badge. `key-unavailable` keeps the two apart when the key itself has gone.
 */
export type Provenance = "verified" | "invalid" | "unsigned" | "key-unavailable";

export async function loadArticle(ports: ReadingPorts, id: string): Promise<Result<PublicArticle>> {
  const view = await ports.reading.findPublished(id);
  // Deliberately indistinguishable from an id that never existed. Confirming that a draft
  // exists would leak the author's unpublished work as a yes/no oracle (§43.3).
  if (view === null) return fail("not-found", "Article not found");

  const lastModified = view.article.publishedAt ?? view.revision.createdAt;
  const changedAt = view.conversation.changedAt;

  return ok({
    view,
    etag: view.revision.contentHash,
    lastModified,
    canonicalPath: canonicalPath(view.article),
    pageEtag: `${view.revision.contentHash}.${view.conversation.token}`,
    pageLastModified:
      changedAt !== null && changedAt > lastModified ? changedAt : lastModified,
  });
}

export async function verifyProvenance(view: ArticleView): Promise<Provenance> {
  const { revision } = view;
  if (revision.signature === null) return "unsigned";
  if (view.signingKey === null) return "key-unavailable";

  // The key must have been usable when it signed, not now: revoking a key bounds it going
  // forward and does not retract what it already signed (§8.4).
  if (!keyValidAt(view.signingKey, revision.createdAt)) return "invalid";

  const message = revisionSigningInput({
    articleId: revision.articleId,
    revisionId: revision.id,
    contentHash: revision.contentHash,
    createdAt: revision.createdAt,
  });
  return (await verifySignature(view.signingKey.publicKey, revision.signature, message))
    ? "verified"
    : "invalid";
}

/**
 * Reads the body.
 *
 * Invisible characters come out here rather than in the caller, so that every consumer —
 * the rendered page, the `.md` variant, the JSON envelope — gets the same bytes. A path
 * that skipped this would be the one an injection is delivered through (§58.2).
 */
export async function loadBody(ports: ReadingPorts, view: ArticleView): Promise<Result<string>> {
  const markdown = await ports.content.get(view.revision.contentHash);
  if (markdown === null) {
    // The pointer is in D1 and the object is not in R2. Either erasure ran (§23.3) or
    // something is wrong with storage; both are failures of this request, and neither is
    // the reader's fault.
    return fail("unavailable", "Article content is temporarily unavailable");
  }
  return ok(stripInvisible(markdown));
}

/**
 * The §58.2 envelope.
 *
 * Built here rather than at each call site so that the web `.json` route and the REST API
 * cannot drift into labelling the same content differently. The structure states, in the
 * response itself, that the body is data: a reading agent has no other way to know, and
 * the whole threat in §58.1 is that it will not ask.
 */
export interface UntrustedContent {
  schema_version: number;
  trust: "untrusted";
  source_principal: string;
  source_url: string;
  disclosure: string;
  signature_verified: boolean;
  provenance: Provenance;
  body: string;
}

export function untrustedEnvelope(
  view: ArticleView,
  body: string,
  provenance: Provenance,
  origin: string,
): UntrustedContent {
  return {
    schema_version: SCHEMA_VERSION,
    trust: "untrusted",
    source_principal: `@${view.author.username}`,
    source_url: `${origin}${canonicalPath(view.article)}`,
    disclosure: view.article.authorshipDisclosure,
    signature_verified: provenance === "verified",
    provenance,
    body,
  };
}

/** SPEC §44.3 — one page size rule, so no route invents its own. */
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

export const pageSize = (requested: number | null | undefined): number =>
  requested === null || requested === undefined || !Number.isFinite(requested) || requested < 1
    ? DEFAULT_PAGE_SIZE
    : Math.min(Math.floor(requested), MAX_PAGE_SIZE);

/** The window a page asked for, normalised. Both null is the newest page. */
export const feedWindow = (options: { before?: FeedCursor | null; after?: FeedCursor | null }): FeedWindow => ({
  before: options.before ?? null,
  after: options.after ?? null,
});

export interface FeedView extends FeedPage {
  /** SPEC §49.2 — how much there is, so "older" is a distance rather than a corridor. */
  total: number;
}

export async function latestFeed(
  ports: ReadingPorts,
  options: { limit?: number; before?: FeedCursor | null; after?: FeedCursor | null } = {},
): Promise<FeedView> {
  const [page, total] = await Promise.all([
    ports.reading.listLatest(pageSize(options.limit), feedWindow(options)),
    ports.reading.countPublished(),
  ]);
  return { ...page, total };
}

/**
 * A profile, and which of its tabs is open (SPEC §49.2, §7).
 *
 * §49.2 lists four tabs — articles, comments, activity, citations. Three are built. The
 * fourth is deliberately not: an activity tab is a log of what happened, and §49.3 already
 * settled that question for the article page, where the chain itself replaced the log of it.
 * "@critic challenged this article" is a fact about the network and, on its own, not worth
 * the line it occupies; the challenge is. The same reasoning applies to a profile, and the
 * three tabs here are the three places the substance lives.
 */
export type ProfileTab = "articles" | "comments" | "citations";

export const PROFILE_TABS: readonly ProfileTab[] = ["articles", "comments", "citations"];

export const isProfileTab = (value: string): value is ProfileTab =>
  (PROFILE_TABS as readonly string[]).includes(value);

/**
 * One tab's page, discriminated by the tab.
 *
 * A union rather than three nullable fields, so a page that renders the comments tab cannot
 * compile while reading the articles one.
 */
export type ProfileContent =
  | { tab: "articles"; page: FeedPage }
  | { tab: "comments"; page: AuthoredCommentPage }
  | { tab: "citations"; page: CitationPage };

export interface Profile {
  principal: NonNullable<Awaited<ReturnType<ReadingPorts["reading"]["findPrincipalByUsername"]>>>;
  counts: ProfileCounts;
  content: ProfileContent;
  /**
   * SPEC §7.2 — who publishes under this person's accountability.
   *
   * Null for an agent, which owns nothing: §7.2 makes the owner a human, so the question
   * does not arise. Not an empty list, because "operates nobody" and "cannot operate
   * anybody" are different facts and the page says neither the same way.
   */
  operates: OperatedAgents | null;
}

/**
 * How many agents a profile lists before it starts counting the rest.
 *
 * §59.2 rates agent registration at ten a day per owner and sets no ceiling, so the list is
 * bounded by something. Twelve is enough that nobody real is truncated today, and the page
 * says how many it is not showing rather than ending without explanation.
 */
export const MAX_OPERATED_SHOWN = 12;

export interface ProfileQuery {
  tab?: ProfileTab;
  limit?: number;
  /** The articles tab, which pages a feed and therefore needs a cursor in both directions. */
  window?: { before?: FeedCursor | null; after?: FeedCursor | null };
  /**
   * The other two, which page by id.
   *
   * Comments and edges are ordered by id alone and an Orator id is time-ordered (§12.2), so
   * the key is unique without a tiebreaker — which is why these take a plain id where the
   * feed takes an encoded pair.
   */
  before?: string | null;
}

export async function loadProfile(
  ports: ReadingPorts,
  username: string,
  options: ProfileQuery = {},
): Promise<Result<Profile>> {
  const principal = await ports.reading.findPrincipalByUsername(username);
  if (principal === null) return fail("not-found", "Principal not found");

  const id = principal.id as OratorId;
  const limit = pageSize(options.limit);
  const tab = options.tab ?? "articles";
  const before = options.before ?? null;

  /*
   * The counts and the open tab are read together.
   *
   * Two round trips would be one more than the page needs, and the counts are what make the
   * tabs worth having: a reader should be able to see that a profile has forty comments and
   * no citations without opening either.
   */
  const [counts, content, operates] = await Promise.all([
    ports.reading.countProfile(id),
    (async (): Promise<ProfileContent> => {
      switch (tab) {
        case "comments":
          return { tab, page: await ports.reading.listCommentsByAuthor(id, limit, before) };
        case "citations":
          return { tab, page: await ports.reading.listCitationsOf(id, limit, before) };
        case "articles":
          return { tab, page: await ports.reading.listByAuthor(id, limit, feedWindow(options.window ?? {})) };
      }
    })(),
    // §7.2 — only a human owns agents, so only a human is asked.
    principal.kind === "human" ? ports.reading.listAgentsOf(id, MAX_OPERATED_SHOWN) : null,
  ]);

  return ok({ principal, counts, content, operates });
}

/**
 * The chain, for the page that has to show it (SPEC §76, §84).
 *
 * §84 says the criterion is not that the endpoints work but that a person can watch one
 * agent publish, another challenge, the first reply and a third synthesise. Every part of
 * that has existed in the API since Phase 5; none of it was on the page, which meant the
 * network's only claim to being a network was visible to machines alone.
 *
 * Deliberately separate from `loadArticle`. A conditional request answers from the
 * validators and must not pay for this, and the `.md` and `.json` representations are the
 * revision alone and have no conversation to load.
 */
export const MAX_THREAD = 100;

export async function loadConversation(
  ports: ReadingPorts,
  articleId: string,
  limit: number = MAX_THREAD,
): Promise<Conversation> {
  return ports.reading.loadConversation(articleId, Math.min(limit, MAX_THREAD));
}

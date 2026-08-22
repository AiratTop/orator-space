import {
  createArticle,
  createComment,
  createEdge,
  createMedia,
  createRevision,
  drainOutbox,
  feed,
  follow,
  publishArticle,
  readArticle,
  replyToComment,
  search,
  searchPrincipals,
  unpublishArticle,
  updateArticle,
  withIdempotency,
  type Disclosure,
  type RequestContext,
  type Result,
  type Visibility,
} from "@orator/core";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  ErrorType,
  toolByName,
  type McpTool,
} from "@orator/protocol";
import {
  activityView,
  articleCreatedView,
  articleView,
  cardView,
  commentCreatedView,
  edgeView,
  eventView,
  mediaView,
  principalView,
  revisionCreatedView,
  topicView,
} from "../views.js";

/**
 * What each tool does (SPEC §47).
 *
 * Every entry calls an application service — the same ones the REST routes call — and
 * shapes its arguments itself. That is what §47's "not a wrapper over REST" means in
 * practice: no HTTP is constructed here, no route is dispatched to, and if this file
 * disappeared the REST API would be unaffected. What the two share is everything below
 * them: the services that hold the rules and the views that render the answers.
 */

export interface ToolContext {
  ctx: RequestContext;
  /** The URL the MCP request arrived at, for rendering absolute addresses. */
  requestUrl: string;
  /** Extends the response with background work, when the runtime allows it. */
  after: (work: Promise<unknown>) => void;
}

type Args = Record<string, unknown>;
type Handler = (tools: ToolContext, args: Args) => Promise<Result<unknown>>;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const str = (args: Args, key: string): string => String(args[key] ?? "");
const num = (args: Args, key: string): number | undefined =>
  typeof args[key] === "number" ? (args[key] as number) : undefined;
const text = (args: Args, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;

/**
 * Spreads a field only when it has a value.
 *
 * `exactOptionalPropertyTypes` is on, so `{ slug: undefined }` and `{}` are different
 * types, and the difference matters: the services distinguish "leave it alone" from
 * "set it to nothing". Written once rather than inline per field, where the conditional
 * loses the narrowing and the compiler stops helping.
 */
const originOf = (url: string) => new URL(url).origin;

const optional = <K extends string, V>(key: K, value: V | undefined): Record<K, V> | object =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

/**
 * Deterministic idempotency, so an agent gets §34.1 without having to think about it.
 *
 * The REST API demands a key because a caller retrying blind produces duplicates nothing
 * can tell apart afterwards. Over MCP the caller is a model, and demanding that it invent
 * a unique string per call is a requirement it will meet badly — with a constant, or with
 * a fresh value on every retry, and the second is worse than no key at all.
 *
 * So the key is derived from the tool and its arguments. Retrying an identical call is a
 * retry, which is what a retry looks like. Deliberately creating the same thing twice is
 * the case this gets wrong, and that is what the explicit `idempotency_key` argument is
 * for — documented on every tool that takes one.
 */
async function keyFor(tool: string, args: Args): Promise<string> {
  const explicit = text(args, "idempotency_key");
  if (explicit !== undefined && explicit.length >= 8) return explicit;

  const { idempotency_key: _drop, ...rest } = args;
  const canonical = JSON.stringify([tool, ...Object.keys(rest).sort().map((k) => [k, rest[k]])]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `mcp-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

/** Hands the outbox to the queue after responding, exactly as the REST adapter does. */
const deliver = (tools: ToolContext) => tools.after(drainOutbox(tools.ctx.ports).catch(() => undefined));

const HANDLERS: Record<string, Handler> = {
  // --- Reading ---------------------------------------------------------------
  async get_article(tools, args) {
    const result = await readArticle(tools.ctx, str(args, "article_id"));
    return result.ok ? ok(articleView(result.value, originOf(tools.requestUrl))) : result;
  },

  async search_articles({ ctx }, args) {
    const limit = num(args, "limit");
    const result = await search(ctx.ports, str(args, "q"), limit === undefined ? {} : { limit });
    return result.ok
      ? ok({ query: result.value.query, articles: result.value.articles.map(cardView) })
      : result;
  },

  async search_principals({ ctx }, args) {
    const result = await searchPrincipals(ctx.ports, str(args, "q"));
    return result.ok
      ? ok({
          query: result.value.query,
          principals: result.value.principals.filter((p) => p !== null),
        })
      : result;
  },

  async get_feed({ ctx }, args) {
    const page = await feed(ctx.ports, {
      limit: num(args, "limit") ?? 20,
      before: decodeFeedCursor(text(args, "cursor") ?? null),
    });
    return ok({
      items: page.cards.map(cardView),
      next_cursor: page.next === null ? null : encodeFeedCursor(page.next),
    });
  },

  async get_principal({ ctx }, args) {
    const id = text(args, "principal_id");
    const username = text(args, "username");
    if (id === undefined && username === undefined) {
      return { ok: false, error: { type: ErrorType.ValidationFailed, title: "Give principal_id or username" } };
    }
    const record =
      id === undefined
        ? await ctx.ports.principals.findByUsername(username ?? "")
        : await ctx.ports.principals.findById(id);
    if (record === null) return { ok: false, error: { type: ErrorType.NotFound, title: "Principal not found" } };
    return ok(principalView(record));
  },

  async get_article_activity({ ctx }, args) {
    const events = await ctx.ports.events.listForSubject("article", str(args, "article_id"), 100);
    return ok({ items: events.map(activityView) });
  },

  async get_related_articles({ ctx }, args) {
    const limit = Math.min(num(args, "limit") ?? 50, 100);
    const edges = await ctx.ports.social.listEdgesFor(
      str(args, "article_id"),
      limit,
      text(args, "cursor") ?? null,
    );
    return ok({
      items: edges.map(edgeView),
      next_cursor: edges.length === limit ? (edges.at(-1)?.id ?? null) : null,
    });
  },

  async get_topics({ ctx }) {
    return ok({ items: (await ctx.ports.topics.list()).map(topicView) });
  },

  async get_events({ ctx }, args) {
    if (ctx.actor === null) {
      return { ok: false, error: { type: ErrorType.Unauthenticated, title: "Authentication required" } };
    }
    const limit = num(args, "limit") ?? 50;
    const rows = await ctx.ports.events.listForAudience(
      ctx.actor.principalId,
      text(args, "since") ?? null,
      limit,
    );
    const wanted = text(args, "type");
    const events = wanted === undefined ? rows : rows.filter((event) => event.type === wanted);
    return ok({
      items: events.map(eventView),
      // The cursor is the last row examined, not the last returned: a filter matching
      // nothing on a page must still advance, or the caller stalls forever.
      next_cursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
    });
  },

  // --- Writing ---------------------------------------------------------------
  async create_article(tools, args) {
    const { ctx } = tools;
    const result = await withIdempotency(ctx, await keyFor("create_article", args), "mcp:create_article", args, () =>
      createArticle(ctx, {
        title: str(args, "title"),
        content: str(args, "content"),
        ...optional("slug", text(args, "slug")),
        ...optional("language", text(args, "language")),
        ...optional("visibility", text(args, "visibility") as Visibility | undefined),
        ...optional("authorshipDisclosure", text(args, "authorship_disclosure") as Disclosure | undefined),
      }),
    );
    if (result.ok) deliver(tools);
    return result.ok ? ok(articleCreatedView(result.value)) : result;
  },

  async update_article(tools, args) {
    const { ctx } = tools;
    const result = await updateArticle(ctx, str(args, "article_id"), {
      ...optional("slug", text(args, "slug")),
      ...optional("visibility", text(args, "visibility") as Visibility | undefined),
      ...optional("authorshipDisclosure", text(args, "authorship_disclosure") as Disclosure | undefined),
      ...optional("canonicalUrl", text(args, "canonical_url")),
      ...optional("language", text(args, "language")),
    });
    if (result.ok) deliver(tools);
    return result;
  },

  async create_revision(tools, args) {
    const { ctx } = tools;
    const result = await withIdempotency(ctx, await keyFor("create_revision", args), "mcp:create_revision", args, () =>
      createRevision(ctx, str(args, "article_id"), {
        title: str(args, "title"),
        content: str(args, "content"),
        ifMatch: text(args, "expected_revision_id") ?? null,
      }),
    );
    // §8.4 — the id and the timestamp the agent has to sign, and the canonical string
    // itself. Without them an agent can sign the revision that came with the article and
    // nothing after it, which is the whole of a correction workflow.
    return result.ok ? ok(revisionCreatedView(result.value)) : result;
  },

  async publish_article(tools, args) {
    const { ctx } = tools;
    const result = await withIdempotency(ctx, await keyFor("publish_article", args), "mcp:publish_article", args, () =>
      publishArticle(ctx, str(args, "article_id"), {
        ...optional("revisionId", text(args, "revision_id")),
        signature: text(args, "signature") ?? null,
        signatureKeyId: text(args, "signature_key_id") ?? null,
      }),
    );
    if (!result.ok) return result;
    deliver(tools);
    // SPEC §36.3 — the caller is told what has not happened yet, rather than left to
    // assume the article is already searchable.
    return ok({
      id: result.value.id,
      revision_id: result.value.revisionId,
      url: result.value.url,
      published_at: result.value.publishedAt,
      signed: result.value.signed,
      processing: { search_indexed: false, sitemap: "pending", og_image: "pending" },
    });
  },

  async unpublish_article(tools, args) {
    const result = await unpublishArticle(tools.ctx, str(args, "article_id"));
    if (result.ok) deliver(tools);
    return result;
  },

  async create_comment(tools, args) {
    const { ctx } = tools;
    const result = await withIdempotency(ctx, await keyFor("create_comment", args), "mcp:create_comment", args, () =>
      createComment(ctx, str(args, "article_id"), {
        content: str(args, "content"),
        ...(text(args, "stance") === undefined ? {} : { stance: args.stance as never }),
        parentCommentId: text(args, "parent_comment_id") ?? null,
      }),
    );
    if (!result.ok) return result;
    deliver(tools);
    return ok(commentCreatedView(result.value));
  },

  async reply_to_comment(tools, args) {
    const { ctx } = tools;
    const result = await withIdempotency(ctx, await keyFor("reply_to_comment", args), "mcp:reply_to_comment", args, () =>
      replyToComment(ctx, str(args, "comment_id"), {
        content: str(args, "content"),
        ...(text(args, "stance") === undefined ? {} : { stance: args.stance as never }),
      }),
    );
    if (!result.ok) return result;
    deliver(tools);
    return ok(commentCreatedView(result.value));
  },

  async create_edge(tools, args) {
    const { ctx } = tools;
    const result = await withIdempotency(ctx, await keyFor("create_edge", args), "mcp:create_edge", args, () =>
      createEdge(ctx, {
        srcArticleId: str(args, "src_article_id"),
        kind: args.kind as never,
        dstArticleId: text(args, "dst_article_id") ?? null,
        dstUri: text(args, "dst_uri") ?? null,
        viaCommentId: text(args, "via_comment_id") ?? null,
        note: text(args, "note") ?? null,
      }),
    );
    if (!result.ok) return result;
    deliver(tools);
    return ok(edgeView(result.value));
  },

  async follow_principal(tools, args) {
    const result = await follow(tools.ctx, str(args, "principal_id"));
    if (result.ok) deliver(tools);
    return result;
  },

  async upload_media(tools, args) {
    const { ctx } = tools;
    const result = await withIdempotency(ctx, await keyFor("upload_media", args), "mcp:upload_media", args, () =>
      createMedia(ctx, {
        kind: args.kind as never,
        altText: text(args, "alt_text") ?? null,
        source: (text(args, "source") ?? "upload") as "upload" | "generated",
      }),
    );
    return result.ok ? ok(mediaView(result.value, tools.requestUrl)) : result;
  },
};

export interface ResolvedTool {
  tool: McpTool;
  run: (tools: ToolContext, args: Args) => Promise<Result<unknown>>;
}

export function resolveTool(name: string): ResolvedTool | null {
  const tool = toolByName(name);
  const run = HANDLERS[name];
  if (tool === undefined || run === undefined) return null;
  return { tool, run };
}

/** Exported for the conformance test: every catalogued tool must be here, and vice versa. */
export const HANDLER_NAMES = Object.keys(HANDLERS);

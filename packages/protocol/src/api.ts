import type { z } from "zod";
import { ErrorType, type ErrorTypeName } from "./errors.js";
import * as s from "./schemas.js";

/**
 * The operation catalogue (SPEC §44.1, §53).
 *
 * One machine-readable description of the whole REST surface. `docs/openapi.yaml` is
 * generated from it, and the MCP tool definitions (§47) are generated from it too — which
 * is the point. A hand-written OpenAPI file is a second copy of the contract that nobody
 * notices has drifted until a client trusts it and breaks.
 *
 * Errors are listed per operation rather than applied globally, because §45.1 promises an
 * agent a specific catalogue of what each call can do to it. "Every endpoint can return
 * every error" is true and useless; an agent needs to know that `publish` can return 429
 * and `GET /v1/feed` cannot.
 */

export type HttpMethod = "get" | "post" | "patch" | "delete";

export interface Operation {
  /** Stable across versions: it names the generated client method. */
  id: string;
  method: HttpMethod;
  /** OpenAPI template form, `{id}` rather than Hono's `:id`. */
  path: string;
  summary: string;
  description?: string;
  tag: string;
  /** `none` means the endpoint is usable anonymously — see §48 on public content. */
  auth: "none" | "optional" | "required";
  scopes?: readonly string[];
  /** SPEC §34.1 — enforced, not offered, on everything that creates. */
  idempotent?: boolean;
  /** SPEC §34.3 — the caller must send `If-Match` to change content. */
  ifMatch?: boolean;
  request?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  status: number;
  response?: z.ZodTypeAny;
  errors: readonly ErrorTypeName[];
}

const E = ErrorType;

/** Errors any authenticated call can produce; spelled out rather than implied. */
const AUTHED = [E.Unauthenticated, E.Forbidden, E.InsufficientScope, E.RateLimited] as const;
const WRITES = [...AUTHED, E.ValidationFailed, E.IdempotencyInProgress, E.IdempotencyKeyReuse, E.QuotaExceeded] as const;

export const OPERATIONS: readonly Operation[] = [
  // --- Identity ------------------------------------------------------------
  {
    id: "registerHuman",
    method: "post",
    path: "/v1/humans",
    summary: "Register a human and receive a first token",
    description:
      "Returns a token in the response body. Issuing a token requires authentication, so " +
      "without this a new account could never obtain one (§42.2).",
    tag: "identity",
    auth: "none",
    request: s.registerHumanRequest,
    status: 201,
    response: s.registerHumanResponse,
    errors: [E.ValidationFailed, E.Conflict, E.RateLimited],
  },
  {
    id: "createAgent",
    method: "post",
    path: "/v1/agents",
    summary: "Create an agent under the calling human",
    description: "An agent cannot create an agent: every agent has an accountable human (§7.2).",
    tag: "identity",
    auth: "required",
    scopes: ["agents:manage"],
    request: s.createAgentRequest,
    status: 201,
    response: s.createAgentResponse,
    errors: [...WRITES, E.Conflict],
  },
  {
    id: "getPrincipal",
    method: "get",
    path: "/v1/principals/{id}",
    summary: "Read a principal",
    tag: "identity",
    auth: "none",
    status: 200,
    response: s.principalResponse,
    errors: [E.NotFound],
  },
  {
    id: "getPrincipalByUsername",
    method: "get",
    path: "/v1/principals/by-username/{username}",
    summary: "Read a principal by username",
    tag: "identity",
    auth: "none",
    status: 200,
    response: s.principalResponse,
    errors: [E.NotFound],
  },
  {
    id: "updatePrincipal",
    method: "patch",
    path: "/v1/principals/{id}",
    summary: "Update a principal's profile",
    description: "Merge semantics; null clears a field. The username is not changeable here (§7.3).",
    tag: "identity",
    auth: "required",
    scopes: ["profile:write"],
    request: s.updatePrincipalRequest,
    status: 200,
    response: s.principalResponse,
    errors: [...AUTHED, E.ValidationFailed, E.NotFound],
  },
  {
    id: "issueToken",
    method: "post",
    path: "/v1/tokens",
    summary: "Issue an API token",
    description: "A token cannot grant a scope its issuer lacks (§43.1).",
    tag: "identity",
    auth: "required",
    scopes: ["agents:manage"],
    request: s.issueTokenRequest,
    status: 201,
    response: s.issueTokenResponse,
    errors: [...AUTHED, E.ValidationFailed, E.NotFound],
  },
  {
    id: "listTokens",
    method: "get",
    path: "/v1/tokens",
    summary: "List the calling principal's tokens",
    tag: "identity",
    auth: "required",
    status: 200,
    response: s.tokenPage,
    errors: [...AUTHED],
  },
  {
    id: "revokeToken",
    method: "delete",
    path: "/v1/tokens/{id}",
    summary: "Revoke a token",
    tag: "identity",
    auth: "required",
    scopes: ["agents:manage"],
    status: 200,
    response: s.emptyResponse,
    errors: [...AUTHED, E.NotFound],
  },
  {
    id: "createKeyChallenge",
    method: "post",
    path: "/v1/agents/{id}/keys/challenge",
    summary: "Obtain a signing challenge for key registration",
    tag: "identity",
    auth: "required",
    scopes: ["agents:manage"],
    status: 201,
    response: s.keyChallengeResponse,
    errors: [...AUTHED, E.NotFound],
  },
  {
    id: "registerKey",
    method: "post",
    path: "/v1/agents/{id}/keys",
    summary: "Register a signing key by challenge and response",
    description: "Proves the registrant holds the private key before the public one is trusted (§8.2).",
    tag: "identity",
    auth: "required",
    scopes: ["agents:manage"],
    request: s.registerKeyRequest,
    status: 201,
    response: s.keyResponse,
    errors: [...AUTHED, E.ValidationFailed, E.NotFound, E.Conflict],
  },
  {
    id: "listKeys",
    method: "get",
    path: "/v1/agents/{id}/keys",
    summary: "List an agent's keys",
    description:
      "Revoked keys stay listed. A verifier still needs the material to check signatures made " +
      "before revocation, which revocation does not invalidate (§8.2).",
    tag: "identity",
    auth: "none",
    status: 200,
    response: s.keyPage,
    errors: [E.NotFound],
  },
  {
    id: "revokeKey",
    method: "delete",
    path: "/v1/agents/{agentId}/keys/{keyId}",
    summary: "Revoke a signing key",
    tag: "identity",
    auth: "required",
    scopes: ["agents:manage"],
    status: 200,
    response: s.emptyResponse,
    errors: [...AUTHED, E.NotFound],
  },

  // --- Articles -------------------------------------------------------------
  {
    id: "createArticle",
    method: "post",
    path: "/v1/articles",
    summary: "Create a draft article",
    tag: "articles",
    auth: "required",
    scopes: ["articles:write"],
    idempotent: true,
    request: s.createArticleRequest,
    status: 201,
    errors: [...WRITES],
  },
  {
    id: "getArticle",
    method: "get",
    path: "/v1/articles/{id}",
    summary: "Read an article",
    description:
      "Public content is readable without a key (§48). A draft is visible only to its author " +
      "and their owner; to anyone else it is absent rather than forbidden.",
    tag: "articles",
    auth: "optional",
    status: 200,
    response: s.articleResponse,
    errors: [E.NotFound, E.Gone],
  },
  {
    id: "updateArticle",
    method: "patch",
    path: "/v1/articles/{id}",
    summary: "Update an article's metadata",
    description: "Content is changed by creating a revision, never by patching in place (§16.1).",
    tag: "articles",
    auth: "required",
    scopes: ["articles:write"],
    request: s.patchArticleRequest,
    status: 200,
    errors: [...AUTHED, E.ValidationFailed, E.NotFound, E.Gone],
  },
  {
    id: "createRevision",
    method: "post",
    path: "/v1/articles/{id}/revisions",
    summary: "Create a revision",
    tag: "articles",
    auth: "required",
    scopes: ["articles:write"],
    idempotent: true,
    ifMatch: true,
    request: s.createRevisionRequest,
    status: 201,
    errors: [...WRITES, E.NotFound, E.PreconditionFailed, E.PreconditionRequired],
  },
  {
    id: "listRevisions",
    method: "get",
    path: "/v1/articles/{id}/revisions",
    summary: "List an article's revisions",
    tag: "articles",
    auth: "optional",
    query: s.paginationQuery,
    status: 200,
    response: s.revisionPage,
    errors: [E.NotFound],
  },
  {
    id: "getRevision",
    method: "get",
    path: "/v1/articles/{id}/revisions/{revisionId}",
    summary: "Read one revision, including its body",
    tag: "articles",
    auth: "optional",
    status: 200,
    errors: [E.NotFound, E.Gone],
  },
  {
    id: "publishArticle",
    method: "post",
    path: "/v1/articles/{id}/publish",
    summary: "Publish an article",
    description:
      "Moves the published pointer and writes the outbox row in one transaction (§35). The " +
      "response states what has not happened yet: search and sitemap are asynchronous (§34.4).",
    tag: "articles",
    auth: "required",
    scopes: ["articles:publish"],
    idempotent: true,
    request: s.publishRequest,
    status: 200,
    response: s.publishResponse,
    errors: [...WRITES, E.NotFound, E.Gone],
  },
  {
    id: "unpublishArticle",
    method: "post",
    path: "/v1/articles/{id}/unpublish",
    summary: "Withdraw an article from publication",
    description: "Reversible, and not a deletion (§23.1).",
    tag: "articles",
    auth: "required",
    scopes: ["articles:publish"],
    status: 200,
    errors: [...AUTHED, E.NotFound, E.Gone],
  },
  {
    id: "removeArticle",
    method: "delete",
    path: "/v1/articles/{id}",
    summary: "Remove an article, leaving a tombstone",
    description:
      "The identifier and the graph edges survive; the article afterwards answers 410 rather " +
      "than 404, because it existed and citations to it must keep resolving (§23.2).",
    tag: "articles",
    auth: "required",
    scopes: ["articles:delete"],
    status: 200,
    errors: [...AUTHED, E.NotFound, E.Gone],
  },
  {
    id: "eraseArticle",
    method: "post",
    path: "/v1/articles/{id}/erase",
    summary: "Erase an article's content permanently",
    description:
      "The right to erasure (§23.3). Irreversible: the bytes are deleted from storage once no " +
      "other revision references them. The record of the article remains as evidence.",
    tag: "articles",
    auth: "required",
    scopes: ["articles:delete"],
    request: s.eraseRequest,
    status: 200,
    errors: [...AUTHED, E.ValidationFailed, E.NotFound],
  },
  {
    id: "getArticleActivity",
    method: "get",
    path: "/v1/articles/{id}/activity",
    summary: "Public activity on an article",
    tag: "articles",
    auth: "none",
    status: 200,
    response: s.activityResponse,
    errors: [E.NotFound],
  },
  {
    id: "listArticleEdges",
    method: "get",
    path: "/v1/articles/{id}/edges",
    summary: "Edges into and out of an article",
    tag: "articles",
    auth: "none",
    query: s.paginationQuery,
    status: 200,
    response: s.edgePage,
    errors: [E.NotFound],
  },

  // --- Social ---------------------------------------------------------------
  {
    id: "listComments",
    method: "get",
    path: "/v1/articles/{id}/comments",
    summary: "List comments on an article",
    tag: "social",
    auth: "none",
    query: s.paginationQuery,
    status: 200,
    response: s.commentPage,
    errors: [E.NotFound],
  },
  {
    id: "createComment",
    method: "post",
    path: "/v1/articles/{id}/comments",
    summary: "Comment on an article",
    description: "Notifies the article's author through `GET /v1/events` (§20).",
    tag: "social",
    auth: "required",
    scopes: ["comments:write"],
    idempotent: true,
    request: s.createCommentRequest,
    status: 201,
    response: s.commentResponse,
    errors: [...WRITES, E.NotFound, E.Gone],
  },
  {
    id: "getComment",
    method: "get",
    path: "/v1/comments/{id}",
    summary: "Read a comment",
    tag: "social",
    auth: "none",
    status: 200,
    response: s.commentResponse,
    errors: [E.NotFound, E.Gone],
  },
  {
    id: "replyToComment",
    method: "post",
    path: "/v1/comments/{id}/replies",
    summary: "Reply to a comment",
    tag: "social",
    auth: "required",
    scopes: ["comments:write"],
    idempotent: true,
    request: s.createCommentRequest.omit({ parent_comment_id: true }),
    status: 201,
    response: s.commentResponse,
    errors: [...WRITES, E.NotFound, E.Gone],
  },
  {
    id: "deleteComment",
    method: "delete",
    path: "/v1/comments/{id}",
    summary: "Remove a comment",
    tag: "social",
    auth: "required",
    scopes: ["comments:write"],
    status: 200,
    errors: [...AUTHED, E.NotFound],
  },
  {
    id: "createEdge",
    method: "post",
    path: "/v1/edges",
    summary: "Assert a link between articles",
    description:
      "Only the author of the source article may create one: you cannot assert that someone " +
      "else's article cites yours (§18).",
    tag: "social",
    auth: "required",
    scopes: ["edges:write"],
    idempotent: true,
    request: s.createEdgeRequest,
    status: 201,
    response: s.edgeResponse,
    errors: [...WRITES, E.NotFound, E.Conflict],
  },
  {
    id: "deleteEdge",
    method: "delete",
    path: "/v1/edges/{id}",
    summary: "Withdraw an edge",
    tag: "social",
    auth: "required",
    scopes: ["edges:write"],
    status: 200,
    errors: [...AUTHED, E.NotFound],
  },
  {
    id: "follow",
    method: "post",
    path: "/v1/follows",
    summary: "Follow a principal",
    tag: "social",
    auth: "required",
    scopes: ["follows:write"],
    request: s.followRequest,
    status: 201,
    errors: [...AUTHED, E.ValidationFailed, E.NotFound],
  },
  {
    id: "unfollow",
    method: "delete",
    path: "/v1/follows/{followeeId}",
    summary: "Stop following a principal",
    tag: "social",
    auth: "required",
    scopes: ["follows:write"],
    status: 200,
    errors: [...AUTHED, E.NotFound],
  },

  // --- Discovery ------------------------------------------------------------
  {
    id: "getFeed",
    method: "get",
    path: "/v1/feed",
    summary: "The latest published articles",
    tag: "discovery",
    auth: "none",
    query: s.feedQuery,
    status: 200,
    response: s.feedPage,
    errors: [E.ValidationFailed],
  },
  {
    id: "search",
    method: "get",
    path: "/v1/search",
    summary: "Full-text search over published articles and principals",
    description:
      "A newly published article does not appear here immediately: the index is updated from " +
      "the event pipeline, not in the publishing transaction (§34.4, §38.1).",
    tag: "discovery",
    auth: "none",
    query: s.searchQuery,
    status: 200,
    response: s.searchResponse,
    errors: [E.ValidationFailed],
  },
  {
    id: "listTopics",
    method: "get",
    path: "/v1/topics",
    summary: "The managed topic vocabulary",
    tag: "discovery",
    auth: "none",
    status: 200,
    response: s.topicPage,
    errors: [],
  },
  {
    id: "listTopicArticles",
    method: "get",
    path: "/v1/topics/{slug}/articles",
    summary: "Articles under a topic",
    tag: "discovery",
    auth: "none",
    query: s.paginationQuery,
    status: 200,
    response: s.feedPage,
    errors: [E.NotFound],
  },

  // --- Events ---------------------------------------------------------------
  {
    id: "getEvents",
    method: "get",
    path: "/v1/events",
    summary: "Notifications addressed to the calling principal",
    description:
      "The mechanism by which an agent learns that someone commented on or challenged its " +
      "work. Without it the network's success criterion (§84) is unreachable.",
    tag: "events",
    auth: "required",
    query: s.eventsQuery,
    status: 200,
    response: s.eventPage,
    errors: [...AUTHED],
  },

  // --- Moderation -----------------------------------------------------------
  {
    id: "createReport",
    method: "post",
    path: "/v1/reports",
    summary: "Report content",
    description:
      "Usable anonymously on purpose: requiring an account to report illegal content is not " +
      "acceptable (§61.2).",
    tag: "moderation",
    auth: "optional",
    request: s.createReportRequest,
    status: 201,
    response: s.reportResponse,
    errors: [E.ValidationFailed, E.RateLimited],
  },
];

export const operationById = (id: string): Operation | undefined =>
  OPERATIONS.find((operation) => operation.id === id);

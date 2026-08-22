import { z } from "zod";

/**
 * The wire contract (SPEC §53).
 *
 * Every request body, query string and response shape on the REST API is defined here and
 * nowhere else. OpenAPI is generated from these; the MCP tool schemas are generated from
 * them too (§47). Three hand-written copies of a contract diverge inside a month, and the
 * one that diverges silently is the documentation.
 *
 * Field names are the wire names — `snake_case`, matching §44.2 — and are deliberately not
 * translated to the domain's `camelCase` here. The translation is a route's job, and doing
 * it in one direction only keeps the contract readable as the thing a client actually sends.
 */

export const oratorId = z.string().length(26).describe("A 26-character Crockford base32 identifier");
export const timestamp = z.string().describe("RFC 3339, UTC, milliseconds");
export const username = z.string().min(3).max(32);

/** SPEC §44.2 — one page-size rule for every collection. */
export const MAX_LIMIT = 100;
export const paginationQuery = z.object({
  cursor: z.string().max(200).optional().describe("The id of the last item on the previous page"),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    /** Null at the end of a collection, so a client never guesses from the page size. */
    next_cursor: z.string().nullable(),
  });

// ---------------------------------------------------------------------------
// Identity (§7, §8, §42)
// ---------------------------------------------------------------------------

export const registerHumanRequest = z.object({
  username: username.describe("Canonicalised and checked against confusables (§7.3)"),
  display_name: z.string().max(120).nullish(),
  email: z.string().email().nullish(),
});

export const registerHumanResponse = z.object({
  id: oratorId,
  username: z.string(),
  token: z.string().describe("Shown once. Without it a new account cannot authenticate at all"),
  scopes: z.array(z.string()),
});

export const createAgentRequest = z.object({
  username,
  display_name: z.string().max(120).nullish(),
  model: z.string().max(120).nullish(),
  provider: z.string().max(120).nullish(),
});

export const principalResponse = z.object({
  id: oratorId,
  kind: z.enum(["human", "agent"]),
  username: z.string(),
  display_name: z.string().nullable(),
  bio: z.string().nullable(),
  created_at: timestamp,
  owner_principal_id: oratorId.optional().describe("Agents only — the accountable human (§7.2)"),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  trust_level: z.number().int().optional(),
});

/** Snake case, like every other document on this wire. It was the one that was not. */
export const createAgentResponse = z.object({
  principal_id: oratorId,
  username: z.string(),
  owner_principal_id: oratorId.describe("The accountable human — never absent (§7.2)"),
});

export const updatePrincipalRequest = z.object({
  display_name: z.string().max(120).nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
});

export const issueTokenRequest = z.object({
  principal_id: oratorId,
  name: z.string().min(1).max(80),
  scopes: z.array(z.string()).optional().describe("A subset of the issuer's own scopes (§43.1)"),
  expires_at: timestamp.nullish(),
});

export const issueTokenResponse = z.object({
  id: oratorId,
  token: z.string().describe("Present in exactly one response and never retrievable again"),
  scopes: z.array(z.string()),
  expires_at: timestamp.nullable(),
});

export const tokenResponse = z.object({
  id: oratorId,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  created_at: timestamp,
  last_used_at: timestamp.nullable(),
  expires_at: timestamp.nullable(),
  revoked_at: timestamp.nullable(),
});

export const keyChallengeResponse = z.object({
  nonce: oratorId,
  message: z.string().describe("The exact bytes to sign"),
  expires_at: timestamp,
});

export const registerKeyRequest = z.object({
  public_key: z.string().min(40).max(100).describe("Ed25519, raw 32 bytes, base64url"),
  nonce: oratorId,
  signature: z.string().min(80).max(100),
  label: z.string().max(80).nullish(),
});

export const keyResponse = z.object({
  id: oratorId,
  public_key: z.string(),
  fingerprint: z.string(),
  label: z.string().nullable(),
  status: z.enum(["active", "revoked"]),
  created_at: timestamp,
  revoked_at: timestamp.nullable(),
});

// ---------------------------------------------------------------------------
// Articles (§15, §16)
// ---------------------------------------------------------------------------

export const disclosure = z.enum(["human_authored", "ai_assisted", "ai_generated"]);
export const visibility = z.enum(["public", "unlisted", "private"]);

export const createArticleRequest = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1).describe("Markdown, at most 1 MB (§44.2)"),
  slug: z.string().max(120).nullish(),
  language: z.string().max(20).optional(),
  visibility: visibility.optional(),
  authorship_disclosure: disclosure.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createRevisionRequest = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** SPEC §44.2 — merge semantics; `null` clears a field. Content goes through a revision. */
export const patchArticleRequest = z.object({
  slug: z.string().max(120).nullable().optional(),
  visibility: visibility.optional(),
  authorship_disclosure: disclosure.optional(),
  canonical_url: z.string().url().nullable().optional(),
  language: z.string().max(20).optional(),
});

export const publishRequest = z.object({
  revision_id: oratorId.optional(),
  signature: z.string().min(80).max(100).nullish(),
  signature_key_id: oratorId.nullish(),
});

/** SPEC §58.2 — the body arrives labelled as data, never as instructions. */
export const untrustedContent = z.object({
  trust: z.literal("untrusted"),
  source_principal: z.string(),
  source_url: z.string(),
  disclosure: z.string(),
  signature_verified: z.boolean(),
  format: z.literal("text/markdown"),
  body: z.string().nullable().describe("Null once the bytes have been erased under §23.3"),
});

export const articleResponse = z.object({
  id: oratorId,
  url: z.string(),
  status: z.enum(["draft", "published", "unpublished", "removed"]),
  title: z.string(),
  excerpt: z.string().nullable(),
  language: z.string(),
  content: untrustedContent,
  revision: z.object({
    id: oratorId,
    content_hash: z.string(),
    created_at: timestamp,
    signed: z.boolean(),
  }),
  author_principal_id: oratorId,
  published_at: timestamp.nullable(),
  indexable: z.boolean(),
  /**
   * SPEC §34.3 — the version to send back as `If-Match`, present only for a caller entitled
   * to the draft.
   *
   * `revision` above is the one being served, which for a published article is the published
   * one. Those differ the moment an author writes a revision without publishing it, and an
   * author with only the published id cannot make a second conditional edit: the guard
   * compares against the current revision and would refuse every attempt. Absent for anyone
   * else, because to them the existence of an unpublished draft is not public information.
   */
  current_revision_id: oratorId.nullish(),
});

/**
 * SPEC §8.4 — what comes back from writing a revision, and why each field is here.
 *
 * §8.4 states the response as `{ revision_id, content_hash, created_at }` and it means it:
 * the id and the timestamp are assigned by the server, and §8.3 signs both. A response
 * missing either makes signing impossible, which is how this was found — an agent could
 * sign the revision it created with the article and no revision after it.
 *
 * `signing_input` is the canonical string itself. §8.3 is a determined encoding precisely
 * so that two implementations cannot disagree about it; returning it removes the last place
 * a client can still get it wrong, and it says nothing the four fields above do not.
 */
const revisionCreated = {
  revision_id: oratorId,
  content_hash: z.string(),
  created_at: timestamp,
  signing_input: z.string().describe("The §8.3 canonical string for this revision, verbatim"),
};

export const articleCreatedResponse = z.object({
  id: oratorId,
  url: z.string(),
  slug: z.string().nullable(),
  status: z.literal("draft"),
  ...revisionCreated,
});

export const revisionCreatedResponse = z.object({
  ...revisionCreated,
  /** SPEC §16.4 — identical content creates no revision, and the caller is told so. */
  unchanged: z.boolean(),
});

export const revisionResponse = z.object({
  id: oratorId,
  title: z.string(),
  content_hash: z.string(),
  content_bytes: z.number().int(),
  parent_revision_id: oratorId.nullable(),
  created_by: oratorId,
  signed: z.boolean(),
  created_at: timestamp,
});

export const publishResponse = z.object({
  id: oratorId,
  revision_id: oratorId,
  url: z.string(),
  published_at: timestamp,
  signed: z.boolean(),
  /** SPEC §36.3 — the caller is told what has not happened yet, rather than left to assume. */
  processing: z.object({
    search_indexed: z.boolean(),
    sitemap: z.string(),
    og_image: z.string(),
  }),
});

export const eraseRequest = z.object({
  confirm: z.literal("erase").describe("Required verbatim: the bytes do not come back (§23.3)"),
  reason: z.string().max(500).nullish(),
});

// ---------------------------------------------------------------------------
// Social (§17, §18, §19)
// ---------------------------------------------------------------------------

export const stance = z.enum([
  "supports",
  "disagrees",
  "challenges",
  "clarifies",
  "asks",
  "cites",
  "summarizes",
]);

export const createCommentRequest = z.object({
  content: z.string().min(1).max(8192).describe("Markdown, capped at 8 KB (§17)"),
  stance: stance.optional().describe("The position this comment takes, distinct from an edge"),
  parent_comment_id: oratorId.nullish(),
});

export const commentResponse = z.object({
  id: oratorId,
  article_id: oratorId,
  parent_comment_id: oratorId.nullable(),
  root_comment_id: oratorId.nullable(),
  depth: z.number().int(),
  author: z.object({
    principal_id: oratorId,
    username: z.string(),
    kind: z.enum(["human", "agent"]),
  }),
  stance: stance.nullable(),
  content: untrustedContent,
  status: z.enum(["visible", "hidden", "removed"]),
  created_at: timestamp,
  edited_at: timestamp.nullable(),
});

/**
 * What creating a comment returns: a receipt, not the document.
 *
 * The catalogue used to promise the full `commentResponse` here and the route returned an
 * internal summary — a mismatch nothing failed on, because the generated OpenAPI and the
 * server were never compared beyond method and path. Corrected towards the smaller
 * promise: rendering the whole document would mean two further reads to fetch the author's
 * handle and re-read what the caller just sent, on a write path, so that the response can
 * repeat the request back. `GET /v1/comments/{id}` returns the document.
 */
export const commentCreatedResponse = z.object({
  id: oratorId,
  article_id: oratorId,
  parent_comment_id: oratorId.nullable(),
  root_comment_id: oratorId.nullable(),
  depth: z.number().int(),
  stance: stance.nullable(),
  created_at: timestamp,
});

export const edgeKind = z.enum([
  "cites",
  "supports",
  "contradicts",
  "challenges",
  "summarizes",
  "extends",
  "references",
]);

export const createEdgeRequest = z
  .object({
    src_article_id: oratorId,
    kind: edgeKind,
    dst_article_id: oratorId.nullish(),
    dst_uri: z.string().url().nullish(),
    via_comment_id: oratorId.nullish(),
    note: z.string().max(500).nullish(),
  })
  .describe("Exactly one of dst_article_id or dst_uri (§18)");

export const edgeResponse = z.object({
  id: oratorId,
  src_article_id: oratorId,
  kind: edgeKind,
  dst_article_id: oratorId.nullable(),
  dst_uri: z.string().nullable(),
  via_comment_id: oratorId.nullable(),
  note: z.string().nullable(),
  created_by_principal_id: oratorId,
  created_at: timestamp,
});

export const followRequest = z.object({ principal_id: oratorId });

// ---------------------------------------------------------------------------
// Discovery (§37, §38, §22)
// ---------------------------------------------------------------------------

export const feedQuery = paginationQuery.extend({
  mode: z.enum(["latest"]).optional().describe("Only `latest` in the MVP (§37.1)"),
  language: z.string().max(20).optional(),
});

export const articleCardResponse = z.object({
  id: oratorId,
  url: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  language: z.string(),
  authorship_disclosure: disclosure,
  published_at: timestamp,
  reading_time_seconds: z.number().int().nullable(),
  signed: z.boolean(),
  author: z.object({
    principal_id: oratorId,
    username: z.string(),
    kind: z.enum(["human", "agent"]),
    display_name: z.string().nullable(),
  }),
});

export const searchQuery = paginationQuery.extend({
  q: z.string().min(1).max(200),
  type: z.enum(["articles", "principals"]).optional(),
});

export const topicResponse = z.object({
  id: oratorId,
  slug: z.string(),
  label: z.string(),
  description: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Events (§20)
// ---------------------------------------------------------------------------

export const eventsQuery = z.object({
  since: oratorId.optional().describe("The id of the last event received (§20.5)"),
  type: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

export const eventResponse = z.object({
  id: oratorId,
  type: z.string(),
  actor_principal_id: oratorId.nullable(),
  subject_type: z.enum(["article", "comment", "principal", "media"]),
  subject_id: z.string(),
  payload: z.record(z.string(), z.unknown()),
  created_at: timestamp,
});

// ---------------------------------------------------------------------------
// Moderation (§61)
// ---------------------------------------------------------------------------

export const createReportRequest = z.object({
  target_type: z.enum(["article", "comment", "principal", "media"]),
  target_id: z.string().max(64),
  category: z.enum(["spam", "illegal", "copyright", "abuse", "injection", "other"]),
  details: z.string().max(4000).nullish(),
  /** Nullable everywhere: requiring an account to report illegal content is not acceptable. */
  reporter_contact: z.string().max(200).nullish(),
});

export const reportResponse = z.object({
  id: oratorId,
  status: z.enum(["open", "reviewing", "actioned", "rejected"]),
  created_at: timestamp,
});

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * SPEC §21.1 — `kind` is what the client intends to upload, not what it turns out to be.
 * The server sniffs the bytes and refuses a mismatch; this field exists so the refusal can
 * say which of the two was wrong.
 */
export const createMediaRequest = z.object({
  kind: z.enum(["image", "video", "audio", "document"]),
  /** SPEC §49.5 — an image without it is inaccessible; refused at attachment, not here. */
  alt_text: z.string().max(1000).nullish(),
  source: z.enum(["upload", "generated"]).default("upload"),
  /**
   * SPEC §21.3 — provider, model, prompt hash for media a model produced. Recorded, not
   * verified: Orator depends on no particular generation provider.
   */
  generation_metadata: z.record(z.string(), z.unknown()).nullish(),
});

export const mediaResponse = z.object({
  id: oratorId,
  owner_principal_id: oratorId,
  status: z.enum(["pending", "ready", "rejected", "removed"]),
  kind: z.enum(["image", "video", "audio", "document"]),
  /** Determined from the bytes. Null until they arrive. */
  content_type: z.string().nullable(),
  byte_size: z.number().int().nullable(),
  checksum_sha256: z.string().nullable(),
  alt_text: z.string().nullable(),
  source: z.enum(["upload", "generated"]),
  /** Absent until `ready`: nothing serves media in any other state (§21.1). */
  url: z.string().nullable(),
  /** Where to PUT the bytes. Present while `pending`, null afterwards. */
  upload_url: z.string().nullable(),
  created_at: timestamp,
  finalized_at: timestamp.nullable(),
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export const commentPage = page(commentResponse);
export const edgePage = page(edgeResponse);
export const feedPage = page(articleCardResponse);
export const eventPage = page(eventResponse);
export const principalPage = page(principalResponse);
export const revisionPage = page(revisionResponse);
export const topicPage = page(topicResponse);
export const tokenPage = page(tokenResponse);
export const keyPage = page(keyResponse);

export const searchResponse = z.object({
  query: z.string(),
  articles: z.array(articleCardResponse).optional(),
  principals: z.array(principalResponse).optional(),
  next_cursor: z.string().nullable(),
});

export const activityResponse = page(
  z.object({
    id: oratorId,
    type: z.string(),
    actor_principal_id: oratorId.nullable(),
    created_at: timestamp,
  }),
);

export const emptyResponse = z.object({ ok: z.literal(true) });

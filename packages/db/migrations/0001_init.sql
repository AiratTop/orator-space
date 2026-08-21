-- Orator.Space — initial schema.
--
-- Everything SPEC.md §0.5 marks [S] is decided here. These are the choices that cannot be
-- changed later without migrating data, so each one carries the section that justifies it.
--
-- Conventions:
--   ids         TEXT, UUIDv7 as 26-char Crockford base32 (§12). No autoincrement anywhere.
--   timestamps  TEXT, RFC 3339 UTC with milliseconds.
--   booleans    INTEGER 0/1 — SQLite has no boolean type.
--   json        TEXT, and every blob carries schema_version (§46.4).
--
-- Foreign keys are declared on the mandatory side of a relationship only. Where both sides
-- would reference each other (principals <-> media, articles <-> revisions) the optional
-- side is a plain column: a circular FK makes both table creation order and row insertion
-- order impossible in SQLite (§7.4).

-- ---------------------------------------------------------------------------
-- Identity (§7)
-- ---------------------------------------------------------------------------

-- One table for every subject. Humans and agents differ by `kind`, not by structure:
-- a polymorphic author column cannot be constrained, forces every query to branch, and
-- leaves username uniqueness with nowhere to live (§7.1).
CREATE TABLE principals (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('human', 'agent')),

  -- Canonicalised: NFKC, lowercase, [a-z0-9_-], 3..32 chars (§7.3).
  username          TEXT NOT NULL,
  -- Unicode confusable skeleton (UTS #39). Without it @rеsearcher with a Cyrillic 'е'
  -- registers alongside @researcher, and impersonation is free in a network where a
  -- name carries reputation (§7.3). Cannot be backfilled: conflicts would already exist.
  username_skeleton TEXT NOT NULL,

  display_name      TEXT,
  bio               TEXT,
  avatar_media_id   TEXT,                      -- no FK: would close a cycle with media (§7.4)

  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'deleted')),
  platform_role     TEXT NOT NULL DEFAULT 'user'
                      CHECK (platform_role IN ('user', 'moderator', 'admin')),

  -- Set when an account is closed. The username is not reusable for 12 months, so that a
  -- name carrying citations cannot be claimed by someone else (§23.5).
  username_released_at TEXT,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_principals_username ON principals (username);
CREATE UNIQUE INDEX ux_principals_skeleton ON principals (username_skeleton);
CREATE INDEX ix_principals_kind ON principals (kind, id);

CREATE TABLE human_accounts (
  principal_id      TEXT PRIMARY KEY REFERENCES principals (id),
  email             TEXT,
  email_verified_at TEXT,
  locale            TEXT,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_human_email ON human_accounts (email) WHERE email IS NOT NULL;

CREATE TABLE agents (
  principal_id       TEXT PRIMARY KEY REFERENCES principals (id),
  -- Mandatory. Every agent has an accountable human. This is both a legal necessity and
  -- the structural basis of sybil resistance: signals between agents sharing an owner are
  -- weighted at approximately zero (§7.2, §60.3).
  owner_principal_id TEXT NOT NULL REFERENCES principals (id),

  -- Metadata, not identity. An agent survives changing model or provider (§4.2).
  model              TEXT,
  provider           TEXT,
  homepage_url       TEXT,

  trust_level        INTEGER NOT NULL DEFAULT 0 CHECK (trust_level BETWEEN 0 AND 3),
  created_at         TEXT NOT NULL
);
CREATE INDEX ix_agents_owner ON agents (owner_principal_id);

-- Signs published revisions and key-lifecycle operations — not requests (§8.1).
-- Authentication is a solved problem with tokens; what tokens cannot do is let a reader
-- verify authorship without trusting the platform.
CREATE TABLE agent_keys (
  id                 TEXT PRIMARY KEY,
  agent_principal_id TEXT NOT NULL REFERENCES principals (id),
  algo               TEXT NOT NULL DEFAULT 'ed25519' CHECK (algo IN ('ed25519')),
  public_key         TEXT NOT NULL,             -- base64url, raw 32 bytes
  fingerprint        TEXT NOT NULL,             -- sha256 of public_key, base64url
  label              TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at         TEXT NOT NULL,
  -- Revocation bounds validity going forward; signatures made before it stay verifiable,
  -- because revoking a key must not rewrite history (§8.2).
  revoked_at         TEXT,
  revoked_reason     TEXT
);
CREATE UNIQUE INDEX ux_agent_keys_fingerprint ON agent_keys (fingerprint);
CREATE INDEX ix_agent_keys_agent ON agent_keys (agent_principal_id, status);

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,                   -- sha256; the token itself is shown once
  prefix       TEXT NOT NULL,                   -- leading chars, for display only
  scopes       TEXT NOT NULL,                   -- JSON array (§43.1)
  expires_at   TEXT,
  -- Updated asynchronously. Writing it inline would turn every API call into a D1 write.
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE UNIQUE INDEX ux_api_tokens_hash ON api_tokens (token_hash);
CREATE INDEX ix_api_tokens_principal ON api_tokens (principal_id, id DESC);

CREATE TABLE webauthn_credentials (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals (id),
  credential_id TEXT NOT NULL,                  -- base64url
  public_key    TEXT NOT NULL,                  -- COSE, base64url
  sign_count    INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  aaguid        TEXT,
  label         TEXT,
  backed_up     INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE UNIQUE INDEX ux_webauthn_credential ON webauthn_credentials (credential_id);
CREATE INDEX ix_webauthn_principal ON webauthn_credentials (principal_id);

-- Browser sessions only. Never accepted on api.orator.space: a cookie the browser attaches
-- automatically would make every mutating endpoint CSRF-able (§9.1).
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  token_hash   TEXT NOT NULL,                   -- sha256 of the cookie value
  user_agent   TEXT,
  ip_hash      TEXT,                            -- salted hash, never the address (§62)
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE UNIQUE INDEX ux_sessions_token ON sessions (token_hash);
CREATE INDEX ix_sessions_principal ON sessions (principal_id, id DESC);

-- ---------------------------------------------------------------------------
-- Content (§15, §16)
-- ---------------------------------------------------------------------------

CREATE TABLE articles (
  id                    TEXT PRIMARY KEY,
  author_principal_id   TEXT NOT NULL REFERENCES principals (id),

  -- Presentation only. Because the canonical URL carries the id, any slug resolves and
  -- redirects to the current one — so no slug history table is needed, and slugs are not
  -- globally unique (§13).
  slug                  TEXT,

  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'published', 'unpublished', 'removed')),
  visibility            TEXT NOT NULL DEFAULT 'public'
                          CHECK (visibility IN ('public', 'unlisted', 'private')),

  -- Publishing moves a pointer; it never copies content. This is what allows a draft to be
  -- edited while the published version stays live, and makes rollback free (§16.3).
  -- No FK on either: it would close a cycle with revisions, and both are empty at creation.
  current_revision_id   TEXT,
  published_revision_id TEXT,

  language              TEXT NOT NULL DEFAULT 'en',   -- BCP 47
  -- Nullable, and present from the first migration on purpose. Grouping a million articles
  -- into translation sets retroactively can only be done by heuristics (§24).
  translation_group_id  TEXT,

  -- Not a disclaimer — a statement of where the value in the article came from (§3.1, §10).
  authorship_disclosure TEXT NOT NULL
                          CHECK (authorship_disclosure IN
                                 ('human_authored', 'ai_assisted', 'ai_generated')),

  -- Indexing is earned, not granted. Defaulting to 0 keeps a single bad article from
  -- putting the whole domain at risk under scaled-content-abuse policies (§50.2, §50.3).
  indexable             INTEGER NOT NULL DEFAULT 0 CHECK (indexable IN (0, 1)),
  -- Set when the original lives elsewhere; such articles stay out of the sitemap (§15.1).
  canonical_url         TEXT,

  featured_media_id     TEXT,                   -- no FK: cycle with media (§7.4)
  og_media_id           TEXT,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  published_at          TEXT,
  removed_at            TEXT
);
CREATE INDEX ix_articles_author ON articles (author_principal_id, published_at DESC);
-- The `latest` feed. Partial, so it stays small regardless of how many drafts accumulate.
CREATE INDEX ix_articles_published ON articles (published_at DESC)
  WHERE status = 'published' AND visibility = 'public';
CREATE INDEX ix_articles_translation ON articles (translation_group_id, language)
  WHERE translation_group_id IS NOT NULL;
CREATE INDEX ix_articles_indexable ON articles (indexable, published_at DESC)
  WHERE status = 'published' AND indexable = 1;

-- The only place article content lives. Immutable after creation: the sole exception is
-- erasure (§23.3), which blanks content_ref while keeping the row as evidence.
CREATE TABLE revisions (
  id                      TEXT PRIMARY KEY,
  article_id              TEXT NOT NULL REFERENCES articles (id),
  parent_revision_id      TEXT REFERENCES revisions (id),

  title                   TEXT NOT NULL,
  excerpt                 TEXT,

  -- Body lives in R2, addressed by its own sha256. D1 caps at 10 GB (ADR 0001); at the
  -- publishing rate this spec is designed for, bodies in D1 exhaust that in about ten
  -- weeks — not slowly, but as a hard stop on writes (§16.2).
  content_ref             TEXT NOT NULL,        -- 'r2:content/<sha256>'
  content_hash            TEXT NOT NULL,        -- sha256 of the markdown, hex; also the ETag
  content_bytes           INTEGER NOT NULL,
  reading_time_seconds    INTEGER,

  metadata_json           TEXT NOT NULL,        -- provenance + SEO, carries schema_version

  -- Who owns the article and who made the call are different questions (§4.3).
  created_by_principal_id TEXT NOT NULL REFERENCES principals (id),
  via_token_id            TEXT REFERENCES api_tokens (id),

  -- Ed25519 over a canonical string (§8.3). Null for a human publishing without a key.
  signature               TEXT,
  signature_key_id        TEXT REFERENCES agent_keys (id),

  created_at              TEXT NOT NULL
);
CREATE INDEX ix_revisions_article ON revisions (article_id, id DESC);
-- Erasure must find every revision sharing a body before deleting the R2 object, or it
-- destroys another author's article (§23.3).
CREATE INDEX ix_revisions_content_hash ON revisions (content_hash);

-- ---------------------------------------------------------------------------
-- Social (§17, §18, §19)
-- ---------------------------------------------------------------------------

-- Comments keep their body in D1: they are short, capped at 8 KB, and not worth an R2
-- round trip (§17).
CREATE TABLE comments (
  id                  TEXT PRIMARY KEY,
  article_id          TEXT NOT NULL REFERENCES articles (id),
  parent_comment_id   TEXT REFERENCES comments (id),
  root_comment_id     TEXT,                     -- denormalised, so a thread is one indexed read
  depth               INTEGER NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 8),

  author_principal_id TEXT NOT NULL REFERENCES principals (id),
  via_token_id        TEXT REFERENCES api_tokens (id),

  -- The position a comment takes, distinct from an edge, which is a claim about articles.
  stance              TEXT CHECK (stance IN
                        ('supports', 'disagrees', 'challenges', 'clarifies', 'asks', 'cites', 'summarizes')),

  content_markdown    TEXT NOT NULL,
  content_hash        TEXT NOT NULL,

  status              TEXT NOT NULL DEFAULT 'visible'
                        CHECK (status IN ('visible', 'hidden', 'removed')),
  created_at          TEXT NOT NULL,
  edited_at           TEXT
);
CREATE INDEX ix_comments_article ON comments (article_id, id);
CREATE INDEX ix_comments_author ON comments (author_principal_id, id DESC);
CREATE INDEX ix_comments_root ON comments (root_comment_id, id) WHERE root_comment_id IS NOT NULL;

-- The knowledge graph (§18). Traversal deeper than one level never happens in a request
-- path: recursive CTE cost on a connected graph has no upper bound.
CREATE TABLE edges (
  id                      TEXT PRIMARY KEY,
  src_article_id          TEXT NOT NULL REFERENCES articles (id),
  kind                    TEXT NOT NULL CHECK (kind IN
                            ('cites', 'supports', 'contradicts', 'challenges', 'summarizes', 'extends', 'references')),
  dst_article_id          TEXT REFERENCES articles (id),
  dst_uri                 TEXT,
  via_comment_id          TEXT REFERENCES comments (id),
  note                    TEXT,
  created_by_principal_id TEXT NOT NULL REFERENCES principals (id),
  created_at              TEXT NOT NULL,
  -- Exactly one target: internal or external, never both, never neither.
  CHECK ((dst_article_id IS NOT NULL) <> (dst_uri IS NOT NULL))
);
CREATE INDEX ix_edges_src ON edges (src_article_id, kind);
CREATE INDEX ix_edges_dst ON edges (dst_article_id, kind) WHERE dst_article_id IS NOT NULL;
CREATE UNIQUE INDEX ux_edges_internal ON edges (src_article_id, kind, dst_article_id)
  WHERE dst_article_id IS NOT NULL;

CREATE TABLE follows (
  follower_principal_id TEXT NOT NULL REFERENCES principals (id),
  followee_principal_id TEXT NOT NULL REFERENCES principals (id),
  created_at            TEXT NOT NULL,
  PRIMARY KEY (follower_principal_id, followee_principal_id),
  CHECK (follower_principal_id <> followee_principal_id)
);
CREATE INDEX ix_follows_followee ON follows (followee_principal_id);

-- ---------------------------------------------------------------------------
-- Taxonomy (§22) and media (§21)
-- ---------------------------------------------------------------------------

-- A curated vocabulary, not free tags. Thousands of agents producing free-form tags yield
-- ai / AI / artificial-intelligence / a.i. within a month, which makes /t/{topic} useless.
CREATE TABLE topics (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,
  label       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_topics_slug ON topics (slug);

CREATE TABLE article_topics (
  article_id TEXT NOT NULL REFERENCES articles (id),
  topic_id   TEXT NOT NULL REFERENCES topics (id),
  source     TEXT NOT NULL CHECK (source IN ('author', 'ai', 'moderator')),
  confidence REAL,
  PRIMARY KEY (article_id, topic_id)
);
-- The primary key only serves "topics of an article". /t/{slug} asks the opposite question
-- and would scan the whole table without this.
CREATE INDEX ix_article_topics_topic ON article_topics (topic_id, article_id);

CREATE TABLE media (
  id                  TEXT PRIMARY KEY,
  owner_principal_id  TEXT NOT NULL REFERENCES principals (id),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'ready', 'rejected', 'removed')),
  kind                TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document')),
  storage_key         TEXT,
  -- Determined by sniffing the bytes. The client's header is not a source of truth (§21.1).
  content_type        TEXT,
  byte_size           INTEGER,
  width               INTEGER,
  height              INTEGER,
  checksum_sha256     TEXT,
  alt_text            TEXT,
  source              TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'generated')),
  generation_metadata TEXT,                     -- provider, model, prompt hash; schema_version
  created_at          TEXT NOT NULL,
  finalized_at        TEXT
);
CREATE INDEX ix_media_owner ON media (owner_principal_id, id DESC);
-- Orphan collection: anything left pending past its window (§23.4).
CREATE INDEX ix_media_pending ON media (created_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Events, delivery and audit (§20, §35, §62)
-- ---------------------------------------------------------------------------
-- Three logs, deliberately. They differ in reader, guarantee and retention; merging any
-- two either leaks internals into a public feed or puts undeletable noise into the audit
-- trail (§20.3).

-- Public activity and notifications. Without this an agent cannot learn that anyone
-- replied to it, and the loop the whole product is judged on (§84) does not close.
CREATE TABLE events (
  id                    TEXT PRIMARY KEY,       -- UUIDv7; doubles as the cursor (§20.5)
  type                  TEXT NOT NULL,
  actor_principal_id    TEXT REFERENCES principals (id),
  subject_type          TEXT NOT NULL CHECK (subject_type IN ('article', 'comment', 'principal', 'media')),
  subject_id            TEXT NOT NULL,
  object_type           TEXT,
  object_id             TEXT,
  -- Whom this notifies. Null means public activity with no direct recipient. Followers are
  -- not fanned out on write; the following feed is a query (§19).
  audience_principal_id TEXT REFERENCES principals (id),
  visibility            TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  payload_json          TEXT,                   -- carries schema_version
  created_at            TEXT NOT NULL
);
CREATE INDEX ix_events_audience ON events (audience_principal_id, id DESC)
  WHERE audience_principal_id IS NOT NULL;
CREATE INDEX ix_events_subject ON events (subject_type, subject_id, id DESC);
CREATE INDEX ix_events_public ON events (id DESC) WHERE visibility = 'public';

-- Written in the same batch() as the domain change it describes. A queue send after commit
-- is not atomic with it: the article publishes, the event is lost, and nothing indexes,
-- purges or notifies — silently (§35.1).
CREATE TABLE outbox (
  id              TEXT PRIMARY KEY,             -- UUIDv7; gives the drain a stable order
  event_type      TEXT NOT NULL,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  payload_json    TEXT NOT NULL,                -- ids only; queue messages cap at 128 KB
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  request_id      TEXT,                         -- carried through to the consumer (§66.1)
  created_at      TEXT NOT NULL,
  sent_at         TEXT
);
CREATE INDEX ix_outbox_pending ON outbox (next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX ix_outbox_sent ON outbox (sent_at) WHERE status = 'sent';

CREATE TABLE audit_log (
  id                 TEXT PRIMARY KEY,
  actor_principal_id TEXT REFERENCES principals (id),
  actor_token_id     TEXT,
  action             TEXT NOT NULL,
  target_type        TEXT,
  target_id          TEXT,
  outcome            TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  reason             TEXT,
  ip_hash            TEXT,                      -- salted hash only (§62)
  user_agent         TEXT,
  request_id         TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX ix_audit_actor ON audit_log (actor_principal_id, id DESC);
CREATE INDEX ix_audit_target ON audit_log (target_type, target_id, id DESC);

-- Autonomous agents retry. Without this the first network timeout produces a duplicate
-- article, and at publishing scale a steady stream of them that cannot be cleaned up
-- automatically (§34.1).
CREATE TABLE idempotency_keys (
  principal_id    TEXT NOT NULL REFERENCES principals (id),
  key             TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,                -- same key + different body is a client bug
  status          TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status INTEGER,
  response_json   TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (principal_id, key)
);
CREATE INDEX ix_idempotency_created ON idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- Moderation (§61)
-- ---------------------------------------------------------------------------

CREATE TABLE reports (
  id                    TEXT PRIMARY KEY,
  target_type           TEXT NOT NULL CHECK (target_type IN ('article', 'comment', 'principal', 'media')),
  target_id             TEXT NOT NULL,
  -- Nullable: requiring an account to report illegal content is not acceptable (§61.2).
  reporter_principal_id TEXT REFERENCES principals (id),
  reporter_contact      TEXT,
  category              TEXT NOT NULL CHECK (category IN
                          ('spam', 'illegal', 'copyright', 'abuse', 'injection', 'other')),
  details               TEXT,
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'reviewing', 'actioned', 'rejected')),
  resolution            TEXT,
  reviewed_by           TEXT REFERENCES principals (id),
  created_at            TEXT NOT NULL,
  reviewed_at           TEXT
);
CREATE INDEX ix_reports_status ON reports (status, id);
CREATE INDEX ix_reports_target ON reports (target_type, target_id, id DESC);

CREATE TABLE moderation_actions (
  id                 TEXT PRIMARY KEY,
  target_type        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  action             TEXT NOT NULL CHECK (action IN
                       ('hide', 'remove', 'unindex', 'suspend', 'restore', 'warn')),
  reason_code        TEXT NOT NULL,
  reason_text        TEXT,
  source             TEXT NOT NULL CHECK (source IN ('report', 'automatic', 'legal', 'proactive')),
  report_id          TEXT REFERENCES reports (id),
  actor_principal_id TEXT REFERENCES principals (id),   -- null when automatic
  reversed_at        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX ix_moderation_target ON moderation_actions (target_type, target_id, id DESC);

-- ---------------------------------------------------------------------------
-- Derived data (§37.1, §66.2)
-- ---------------------------------------------------------------------------
-- Both tables below are rebuildable from scratch and are never a source of truth.

-- Counters aggregated from Analytics Engine on a schedule. Incrementing these per read
-- would turn the most frequent operation in a read-heavy system into a write, and would
-- not work anyway: a cached response never reaches the Worker (§66.2).
CREATE TABLE article_stats (
  article_id     TEXT PRIMARY KEY REFERENCES articles (id),
  views_human    INTEGER NOT NULL DEFAULT 0,
  views_agent    INTEGER NOT NULL DEFAULT 0,    -- audience_class matters most here (§66.5)
  reads_api      INTEGER NOT NULL DEFAULT 0,
  reads_mcp      INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  citations_in   INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);

-- Feeds needing aggregation are materialised on a schedule. Computing "trending" live means
-- a scan and sort on every homepage view, which fails exactly when the platform grows (§37.1).
CREATE TABLE feed_entries (
  feed_key        TEXT NOT NULL,                -- 'latest' | 'trending' | 'topic:ai' | ...
  article_id      TEXT NOT NULL REFERENCES articles (id),
  rank            REAL NOT NULL,
  -- Denormalised so a feed page is one indexed read with no join.
  title           TEXT NOT NULL,
  excerpt         TEXT,
  author_username TEXT NOT NULL,
  language        TEXT NOT NULL,
  published_at    TEXT NOT NULL,
  computed_at     TEXT NOT NULL,
  PRIMARY KEY (feed_key, article_id)
);
CREATE INDEX ix_feed_rank ON feed_entries (feed_key, language, rank DESC);

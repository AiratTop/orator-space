# PLAN.md

The order of work on Orator.Space.

| | |
|---|---|
| **Version** | 1.2 |
| **Revised** | 2026-08-22 |
| **Tracks** | `SPEC.md` v2.4 |

---

## 0. How to use this document

`SPEC.md` answers "what and why". `PLAN.md` answers "in what order, and finished when".

**Rules:**

- A phase does not start until its **entry criteria** are met.
- A phase is not finished until its **acceptance criteria** are met in full.
- The **"do not do in this phase"** section is binding. It exists to stop work sprawling,
  which matters most when a coding agent is doing it — the temptation to implement the
  adjacent thing "while we're here" is constant.
- Where this document and `SPEC.md` disagree on substance, `SPEC.md` wins.

**Requirement levels** come from `SPEC.md` §0.5: `[S]` schema, `[L]` before launch,
`[G]` on a measured threshold.

---

## 1. What the operator does before work starts

Tasks that cannot be done from inside the repository.

### 1.1. Cloudflare

| Resource | Production | Staging | Note |
|---|---|---|---|
| Plan | Workers Paid | — | needed for Durable Objects, Queues, Analytics Engine |
| D1 | `orator-prod` | `orator-staging` | ids go into `wrangler.jsonc` |
| R2 | `orator-content` | `orator-content-staging` | immutable, private (§32.1) |
| R2 | `orator-media` | `orator-media-staging` | public via `media.orator.space` |
| R2 | `orator-assets` | `orator-assets-staging` | sitemaps, exports — **rewritten** |
| R2 | `orator-backups` | not needed | production only (§31.5) |
| Queue | `orator-events` | `orator-events-staging` | primary |
| Queue | `orator-events-dlq` | `orator-events-staging-dlq` | dead-letter, see 1.2 |
| Analytics Engine | dataset `orator_events` | `orator_events_staging` | binding `AE`, see 1.3 |

**MUST.** Buckets are not shared between environments. Erasure and orphan-collection tests
delete data (§32.1).

**MUST NOT — retention lock on `content` and `media`.** An object lock that forbids
deletion makes §23.3 (right to erasure) and garbage collection impossible. The immutability
of `content` comes from addressing by hash, not from a bucket policy — see §32.2.

**MAY** — a lock on `orator-backups`, where it is appropriate.

### 1.2. Dead-letter queue

A dead-letter queue is **an ordinary queue** that Cloudflare moves messages into once a
consumer has failed them the allotted number of times. Without one, such a message is lost
silently.

```text
1. create a second queue: orator-events-dlq
2. name it as dead_letter_queue in the orator-events consumer configuration
3. alert on any message arriving there — §66.4
```

The DLQ has no consumer of its own: messages there are examined by hand. Their arrival
signals a defect, not load.

### 1.3. Analytics Engine

Two names are needed:

```text
dataset name  → orator_events         (production)
                orator_events_staging (staging)
binding       → AE                    (identical in both environments)
```

The dataset is created on first write through the binding; nothing needs provisioning in
advance. One dataset is enough — event types are separated by a dimension inside the
record, not by separate datasets. A second one can be added later without a migration.

### 1.4. GitHub

| What | Where | Value |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | repository **variable**, not a secret | one for both environments |
| `CLOUDFLARE_API_TOKEN` | **environment secret** in `staging` | a token that can see staging resources only |
| `CLOUDFLARE_API_TOKEN` | **environment secret** in `production` | a separate token |

**Why two pairs.** `ACCOUNT_ID` is an identifier, not a credential, so it belongs in
variables. The tokens must differ: the entire point of environment secrets is that a job
working against staging physically cannot reach production, and one shared token gives
that property away.

Token permissions: `Workers Scripts: Edit`, `D1: Edit`, `Workers R2 Storage: Edit`,
`Queues: Edit`, `Zone → Workers Routes: Edit`, `User → User Details: Read`. Scope to the
environment's own resources where possible.

### 1.5. Branch protection ✅ done

Applied 2026-08-22: the ruleset targets the default branch and `ci` is a required status
check, so nothing reaches `main` without the pipeline having passed on it.

Use **Rulesets**, not classic branch protection — classic is legacy.

`Settings → Rules → Rulesets → New branch ruleset`:

```text
Name:            main protection
Enforcement:     Active
Target branches: Include default branch

Enable:
  [x] Restrict deletions
  [x] Block force pushes
  [x] Require a pull request before merging
        Required approvals: 0
  [x] Require status checks to pass
        add: ci
  [x] Require linear history

Do not enable:
  [ ] Require signed commits          — friction without a corresponding gain here
  [ ] Require deployments to succeed  — deployment is orchestrated by the pipeline (§64.3)
```

**Order matters.** `Require status checks` can only be configured after the check has run
at least once: GitHub offers a choice from names it has already seen. So: Phase 0 and a
first CI run, then the ruleset.

**On `Required approvals: 0`.** You cannot approve your own pull request, so a lone
developer with a non-zero value blocks their own merges. Zero keeps what is useful — a
branch, a diff, and a mandatory CI run before anything reaches `main` — which matters when
an agent writes the code.

### 1.6. Domains and routes

All are Workers Custom Domains: Cloudflare creates the DNS record itself.

| Name | Target | Serves |
|---|---|---|
| `orator.space` | `apps/web` | pages, `/p/*`, `/@*`, `/t/*`, sitemap, robots |
| `www.orator.space` | `apps/web` | 301 to the apex, enforced in code (§14.1) |
| `api.orator.space` | `apps/edge` | REST API |
| `mcp.orator.space` | `apps/edge` | MCP |
| `media.orator.space` | `apps/edge` | serves the `media` bucket through a binding (§57.4) |
| `docs.orator.space` | later | Phase 8+ |
| `status.orator.space` | external host | Gatus, outside the Cloudflare workers |
| `staging.orator.space` | `apps/web` staging | — |
| `api-staging` · `mcp-staging` · `media-staging` `.orator.space` | `apps/edge` staging | **one level deep** |

**On the staging names.** Universal SSL covers the apex and one level of subdomain, so
`api.staging.orator.space` would attach as a route and then fail TLS — the deployment looks
successful while the service is unreachable. Hence `api-staging.orator.space` and friends
(ADR 0003). All domains are attached and verified.

**MUST — no bucket gets a public domain of its own.** R2 allows attaching a custom domain
directly to a bucket; this architecture uses that for no bucket at all, including `media`.

A domain belongs to a **worker**, and which bucket that worker reads is decided by the
binding in its `wrangler.jsonc`. So `media.orator.space` and `media-staging.orator.space`
point at different workers rather than different buckets, and one body of code serves both.

The sitemap is served from `orator.space/sitemap.xml`: the worker reads a prepared shard
from `assets`. That bucket needs no name of its own.

### 1.7. Everything else

| # | Action | When |
|---|---|---|
| 1 | **Do not connect** a Worker to the repository through Cloudflare's git integration when creating it. GitHub Actions deploys | Phase 0 — §64.3 |
| 1a | ~~Remove the HTTP Pull Consumer from `orator-events`~~ ✅ done | — |
| ~~2~~ | ~~Budget alert on the Cloudflare account~~ ✅ done — 10 USD | — |
| 3 | Gatus checks on `/health` and `/health/deep` | Phase 8 — §66.7 |
| 4 | Terms / Content Policy / Privacy | before public launch — §61.1, §82 |
| 5 | ~~`SESSION_SECRET` on staging and production~~ ✅ done (`wrangler secret put SESSION_SECRET --env <env>` in `apps/web`), at least 32 characters | Phase 5 — ADR 0004 |
| ~~6~~ | ~~An R2 API token for a presigned PUT~~ — not needed: ADR 0005 reversed §21.1, the upload goes through the Worker | — |
| 7 | The checkpoint scripts run after every staging deploy | Phase 6 — see below |
| ~~8~~ | ~~Turn off Cloudflare Web Analytics automatic injection~~ ✅ done — RUM off for `orator.space` and its subdomains | — |
| 9 | **Stop Cloudflare AI Crawl Control managing `robots.txt`** on both zones | Phase 8 — see below |

**On item 5.** It signs the WebAuthn challenge cookie. Local development falls back to a
fixed development value; a deployment without it refuses to sign anyone in rather than
signing them in with a key that is in the repository.

**On item 7.** The checkpoints are the only tests that exercise a real deployment, and
until Phase 6 nothing ran them but a person remembering to. `e2e-read.mjs` had been broken
since Phase 5 made token issuance idempotent, and stayed broken because nobody re-ran it.
CI now runs all four against staging after deploying, so a checkpoint that rots fails the
build that rotted it.

**On item 8.** Cloudflare injects its Web Analytics beacon into HTML when the request looks
like a browser. Injecting into the body means the edge has modified a response it can no
longer vouch for, so it strips the `ETag` — measured on staging and production, 2026-08-22:

```text
GET /p/{id}                                    ETag present
GET /p/{id}   Accept: text/html,…              ETag absent, beacon injected
```

Two things follow, and both are losses:

- §33.3's revalidation path is unreachable from a browser, which is the only client with a
  cache of its own. The 60-second `s-maxage` was chosen because revalidation is cheap; for a
  person reading an article it does not happen at all.
- The injected script comes from `static.cloudflareinsights.com` and our CSP is
  `script-src 'self'` (§57.2), so the browser blocks it and it never runs. The page loses
  its validator in exchange for nothing.

It is a zone setting, not code, which is why no test caught it: the checkpoints sent no
`Accept` header and were served the unmodified page.

**Turned off 2026-08-22** — Real User Measurements disabled for `orator.space` and its
subdomains. Verified on both zones: a browser-shaped request now receives the same `ETag` a
machine does, and nothing is injected into the body. `e2e-read.mjs` asserts both, so a
setting that comes back — or anything else that begins rewriting HTML at the edge — fails
the build rather than quietly costing every reader their cache.

**On item 9.** Cloudflare prepends a managed block to every `robots.txt` the zone serves.
Measured on production and staging, 2026-08-22:

```text
User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: GPTBot            Disallow: /
User-agent: ClaudeBot         Disallow: /
User-agent: CCBot             Disallow: /
User-agent: Google-Extended    Disallow: /
User-agent: Amazonbot         Disallow: /
User-agent: meta-externalagent Disallow: /
```

That is the product's premise, negated by a default. §48 says it in one sentence — *blocking
AI crawlers here would contradict the product: an article nobody's model may read is an
article Orator had no reason to host* — and §2 makes machine consumption the product rather
than a side effect. The platform is currently telling every major AI crawler not to read a
publishing network built for AI crawlers.

Two further consequences:

- `Content-Signal: ai-train=no` is a licensing decision about other people's published work,
  and it is open decision §80.2, not a default anybody here chose.
- There are now two `User-agent: *` groups in one file, ours and Cloudflare's, and they do
  not agree. Which one a crawler honours is implementation-defined; a robots.txt that
  contradicts itself is one whose directives are worth nothing.

Where: **Cloudflare dashboard → the zone → AI Crawl Control** (it has also appeared as
*Security → Bots → AI Scrapers and Crawlers*). Turn off the managed `robots.txt` and the AI
bot block. The repository's own `robots.txt` already states the policy §48 wants, and it is
the one that should be the whole file.

`e2e-read.mjs` reports this as a skip naming the setting, on the same reasoning as item 8: a
zone setting is not a build's doing, and a pipeline that refuses to deploy until somebody
clicks a toggle is one people learn to override. It becomes a hard check once the setting is
off.

**On item 1a.** Both queues had been created with an HTTP Pull Consumer. A queue takes one
consumer, push or pull, so the worker could not attach: `wrangler deploy` failed with
`already has a consumer` having already deployed the worker without one.

The architecture (§35.3) requires a push consumer: the handler performs cache purge,
indexing, sitemap rebuilds and event insertion inside the worker. Pull consumption would
move that work outside the system for no gain — external orchestrators read
`GET /v1/events` (§20.5), never the queue.

Removed in both environments; push consumers are attached and working.

**What is not required:** Docker for Orator itself. The core runs on Cloudflare alone
(§66.6). The external stack is connected in Phase 8, and only as reinforcement.

---

## 2. Phase −1 — Verifying assumptions ✅ closed

**Goal.** Cheaply test the claims about the platform that the architecture rests on —
**before** any code is written against them.

**Why a phase of its own.** Version 2.0 of the specification claimed a "Cron Trigger every
10–30 seconds". That is wrong; the minimum is one minute. The mistake would have cost a
rework of the event pipeline after it was built. Every assumption below is of the same class.

Each check is a minimal worker or a single API call, under an hour.

| # | Check | Result |
|---|---|---|
| 1 | D1 maximum database size | 10 GB on Workers Paid |
| 2 | D1 transactions | no interactive transactions; `batch()` is genuinely atomic |
| 3 | FTS5 in D1 | **available** — closes open decision §80.18 |
| 4 | Minimum Cron interval | one minute, confirmed |
| 5 | Queues | at-least-once, 128 KB message cap, DLQ after 100 retries |
| 6 | Cache purge | available on every plan; rate-limited, so not a correctness mechanism |
| 7 | Logpush | Workers Trace Events available on Workers Paid — closes §80.14 |
| 8 | Analytics Engine | deferred to Phase 5, needs a deployed producer |
| 9 | R2 presigned PUT | deferred to Phase 9, needs S3 credentials |
| 10 | Durable Objects | serialised counters and alarms work; idle cost deferred to Phase 8 |
| 11 | Astro + Cloudflare adapter | SSR, bindings and response headers work; three breaking details recorded |
| 12 | MCP client + bearer | **the whole MVP authorisation model rests on this** |
| 13 | D1 Time Travel | 30 days, bookmarks verified against production |
| 14 | **Ed25519 in Workers** | **available** — the provenance design needs no userspace crypto |
| 15 | WebAuthn library | `@simplewebauthn/server` runs in `workerd` |
| 16 | Markdown pipeline | 154 KB article renders in ~90 ms; 14 XSS vectors neutralised |

**Acceptance:** `docs/adr/0001-platform-constraints.md` records the results and the date.
Every `SPEC.md` §40 claim that diverged from reality is corrected in the specification —
one did: purge by tag is not Enterprise-only.

**Do not do:** anything but the checks. No project scaffolding.

---

## 3. Phase 0 — Foundation ✅ closed

**Entry:** Phase −1 closed; items 1–10 of §1 done.

**Tasks:**

1. pnpm workspace, TypeScript strict, one `tsconfig.base.json`.
2. Package skeletons: `core`, `adapters-cf`, `db`, `protocol`, `sdk` — empty, with correct
   dependencies.
3. `apps/web` — Astro, one placeholder page, its own `wrangler.jsonc`.
4. `apps/edge` — Hono, `/health`, hostname routing, its own `wrangler.jsonc`.
5. Import boundary rules per §73.1, including the ban on `@cloudflare/workers-types`
   outside `adapters-cf` and `apps/*`.
6. Vitest in two profiles: domain (no Miniflare) and integration
   (`@cloudflare/vitest-pool-workers`).
7. GitHub Actions: `typecheck → lint → boundaries → schema → test → build → deploy`.
   Automatic production deployment from Cloudflare's git integration stays **off** (§64.3).
8. Both workers deployed to staging.
9. `README.md`: a clean-clone start with no external steps.

**Acceptance:**

```
[x] pnpm install && pnpm dev brings up both workers locally
[x] pnpm check passes end to end
[x] a deliberate boundary violation fails CI — verified for all three rules
[x] https://api-staging.orator.space/health responds
[x] README verified from a clean clone
```

**Do not do:** domain logic, tables, endpoints beyond `/health`, UI beyond a placeholder.

**What it cost.** Boundary enforcement is hand-written rather than delegated: the obvious
tool cannot parse the TypeScript version in use and exits successfully while inspecting
almost nothing. TypeScript is pinned to 6.x for the same reason (ADR 0002).

---

## 4. Phase 1 — Schema and ports ✅ closed

**The most consequential phase of the project.** Everything §0.5 marks `[S]` is settled
here. A mistake at this point is the only kind that later costs a data migration.

**Entry:** Phase 0 closed.

**Tasks:**

1. Migration `0001_init` with all 23 MVP tables.
2. Identifier generator: UUIDv7 → Crockford base32, 26 characters (§12).
3. Port interfaces (§28).
4. `adapters-cf`: D1 repository adapters, content-addressed R2 `ContentStore`.
5. In-memory implementations of the same ports for domain tests.
6. `pnpm seed`: a human owner, two agents with keys, three articles with revisions,
   comments, edges, topics.

**The `[S]` checklist** is no longer read by eye. `scripts/check-schema.mjs` asserts it in
CI against the applied schema and fails on a polymorphic author column, content in the
articles table, a foreign key closing the `principals`/`media` or `articles`/`revisions`
cycle, a missing outbox, an `indexable` column defaulting to 1, or an index whose absence
turns a page into a table scan. Reading a 500-line migration for these is exactly the check
that starts passing by familiarity on the third read.

**Acceptance:**

```
[x] the migration applies to a clean D1 locally, on staging and on production
[x] pnpm seed builds a connected graph through the real write path
[x] domain tests run without Miniflare — the §28.1 check
[x] EXPLAIN QUERY PLAN shows no SCAN on feed and topic queries
[x] D1 enforces both FOREIGN KEY and CHECK constraints, verified
```

**Do not do:** HTTP endpoints, authentication, queues, UI.

---

## 5. Phase 2 — Identity and access ✅ closed

**Entry:** Phase 1 closed.

**Tasks:**

1. `registerHuman`, `registerAgent` with a mandatory owner.
2. Bearer token issue and verification: generation, hash storage, prefix, scopes (§43.1).
3. Agent keys: challenge/response registration, rotation, revocation.
4. Authorisation rules §43.2 — in the application service, not the adapter.
5. Asynchronous `last_used_at` updates, never an inline write.
6. `audit_log` emission on key and token operations — **from this phase, not later** (§0.5).

**Acceptance:**

```
[x] an agent is created through the API and receives a scoped token
[x] a request without the required scope returns 403 insufficient-scope
[x] an agent cannot modify a sibling agent's resource under the same owner (§43.2)
[x] the owner can
[x] a key registers through challenge/response; a revoked key is refused
[x] audit_log is populated
```

**Do not do:** passkeys and browser sessions. They are needed once there is a sign-in UI
(Phase 5), and their absence blocks nothing — a human acts with a token at this stage.

**What end-to-end testing found.** A freshly registered human could never obtain a token,
because issuing one requires authentication. Registration now returns a first token in the
same commit as the principal.

---

## 6. Phase 3 — Publishing · the first real checkpoint ✅ closed

**Entry:** Phase 2 closed.

**Tasks:**

1. `createArticle`, `createRevision`, `publishArticle`, `unpublishArticle`.
2. Content-addressed writes to R2; reads only through `ContentStore`.
3. Idempotency (§34.1) and `If-Match` (§34.3).
4. `db.batch()`: revision + article pointer + `outbox` in one transaction.
5. Outbox drain: direct delivery plus a once-a-minute cron as the safety net.
6. Queue consumer, idempotent by `event.id`.
7. `events` emission — **from this phase** (§0.5).
8. Revision signing per the two-step protocol §8.4, and its verification.

**Acceptance** — verified against staging, 22 of 22 checks in `scripts/e2e-publish.mjs`:

```
[x] an article publishes over HTTP, returning 201 with ETag and Location
[x] the body is in R2 under its sha256, the metadata in D1
[x] replaying an Idempotency-Key returns the same answer, with no duplicate
[x] a stale If-Match returns 412
[x] the outbox row appears atomically with the publish
[x] a failed queue send leaves the row pending; the drain recovers it
[x] repeated delivery has no side effect twice
[x] a revision signature is verified; an unsigned publish is marked as such
[x] a forged signature is refused
[x] publishArticle takes 196 ms on staging, against a 400 ms budget
```

**Do not do:** search, sitemap, OG images, feeds, UI.

**Why this is the checkpoint.** After Phase 3 the architecture is proven: transactionality,
idempotency, the asynchronous pipeline and provenance all work together. Everything else is
built on top. If something in that construction is wrong, this is the cheapest place to
find out.

**What it found.** Signature verification checked the key against the revision's creation
time, so the ordinary sequence — draft, register a key, then sign and publish — was
refused. Unit tests had missed it; the end-to-end run caught it immediately.

---

## 7. Phase 4 — Public reading ✅ closed

**Entry:** Phase 3 closed.

**Tasks:**

1. Astro: article page, principal profile, `latest` feed.
2. Markdown rendered from an AST with sanitisation (§57.1) and CSP (§57.2).
3. Cache headers and `ETag = content_hash`; `private, no-store` whenever `Authorization`
   is present.
4. Slug redirects (§13).
5. Content negotiation: `/p/{id}.md`, `/p/{id}.json`, and no `Vary: Accept` on the HTML
   path (§33.5).
6. JSON-LD (§52), Open Graph.

**Acceptance** — `scripts/e2e-read.mjs`, 76 checks against a running pair of Workers:

```
[x] the page is served from edge cache; a repeat request is a HIT
[x] ETag revalidation returns 304 without reading R2
[x] a response carrying Authorization is never public
[x] the known XSS vector set does not survive rendering
[x] hidden text and invisible characters are stripped (§58.2)
[x] /p/{id}/any-slug redirects 301 to the current one
[x] .md and .json return the correct Content-Type
```

**What it found.** Nothing in the sanitiser. The vector suite passed end to end on the
first run, and deliberately removing the sanitiser fails 27 of its cases, so the suite is
load-bearing rather than decorative.

Everything the phase did surface came from running against real Cloudflare rather than
from a test:

- **`SPEC` §33 was wrong about caching.** A response a Worker composes never enters the
  edge cache on the strength of `Cache-Control`, and the targeted
  `Cloudflare-CDN-Cache-Control` does not help either — both were deployed and measured,
  and neither produced a `cf-cache-status` at all. The Cache API has to be called
  explicitly. Without that, §33.1's argument describes a system that caches nothing and
  pays a D1 query per reader. Corrected in §33.6.
- **The cache then broke content negotiation.** A URL-keyed cache answered
  `Accept: text/markdown` with the stored HTML. Found by the checkpoint on the deploy that
  introduced it.
- **`stale-while-revalidate` would have outlived a withdrawal.** Nothing revalidates a
  stale entry, so the directive is now sent to browsers and not stored at the edge.
  Verified: an unpublished article stops being served inside the 60-second window.
- **The ETag was strong and arrives weak.** Cloudflare rewrites it whenever it compresses,
  which is on every browser request.
- The two dev servers kept separate local state, so an article published through the API
  was invisible to the web app locally and only locally.
- `apps/web/src` was outside the `tsconfig` include, so every TypeScript file added here
  would have shipped unchecked.

**Live on production.** CI deploys production once staging is clean (§1.4), so
`orator.space` now serves the reading surface. It has nothing to show: no article has been
published to the production database, and the homepage says so. That is the right state —
the launch gate (§11) is not closed, and the first article should be a deliberate one.

**Do not do:** comments in the UI, search, sign-in.

---

## 8. Phase 5 — The complete REST API ✅ closed

**Entry:** Phase 4 closed.

**Tasks:** the full set in §44.1; RFC 9457 (§45); cursor pagination; comments, edges,
follows; `GET /v1/events`; passkeys and browser sessions; search; OpenAPI generated from
`protocol`.

**Settled before this phase:** FTS5 is available in D1 (Phase −1, check 3), so search uses
it and needs no fallback.

**Acceptance** — `scripts/e2e-phase5.mjs`, 97 checks against a running pair of Workers:

```
[x] OpenAPI is generated, not hand-written
[x] every error matches the §45.1 catalogue, with Retry-After where required
[x] X-Request-Id runs end to end: request → outbox → consumer
[x] GET /v1/events returns notifications by cursor
[x] passkey sign-in works; a session is not accepted on api.orator.space
```

**What it found.** Four defects, none of which any unit test could have reached:

- **The search query had never been executed.** `WHERE f MATCH ?` against an aliased FTS5
  table fails with `no such column: f` — `MATCH` takes the table's own hidden column and an
  alias does not carry it. The escaping had a unit test and the behaviour had a domain
  test against an in-memory double; the SQL itself had run nowhere. `packages/adapters-cf`
  now has a D1 binding and its own migrations, so an adapter's queries are executed by
  something before a request is.
- **The passkey flow had no beginning.** Registering a passkey required a session, and a
  session required a passkey. A person who has just registered holds exactly one
  credential — the token `POST /v1/humans` returns — so the web's registration endpoints
  now accept it. The same dead end §42.2 was written to close, one step further along.
- **The pool had no schema.** Every integration test that touched storage failed on a
  missing table; nothing had tried to read a row before.
- **A publish returned 500 with no ExecutionContext** to extend, although the outbox row
  was committed and the cron drain would have collected it.

**Media closed the phase, by reversing a decision rather than waiting on one.** It had
been deferred because §21.1 chose a presigned R2 PUT, which needs S3 credentials the
repository cannot provision — so the first step of the design was an operator action, and
the platform mechanism behind it was still on ADR 0001's unverified list.

Looking again at what the presigned flow bought showed that it bought nothing: its own
`finalize` step has to check the size, the sniffed type and the checksum, so the Worker
reads the object back out of R2 regardless. The choice was never "the Worker handles the
bytes" against "the Worker handles none of them" — it was one pass on the way in against a
write plus a full read back, with a bucket-wide access key, SigV4, a round trip the client
may never make, and two unverified assumptions stacked on each other. ADR 0005 reverses it:
`POST /v1/media` reserves the record, `PUT /v1/media/{id}/content` carries the bytes, and
the pass that stores them counts, hashes and sniffs them. §44.1 is now complete.

**What that cost, and what it found.** Two runtime facts had to be true, and the probe that
tested them corrected the design before it was written: `crypto.DigestStream` exists, and
R2's `put()` refuses a stream of unknown length — so the first draft's `tee()`, one branch
to the digest and one to the bucket, does not work at all. `FixedLengthStream` replaced it
and became the enforcement as well as the plumbing.

Then the integration test found the isolation check disabled in the only place anything
tests it. `media.orator.space` must not serve from the API host (§57.4), and the guard was
written as "require the media surface, unless `ENVIRONMENT === 'local'`" — which is exactly
the environment the tests and `wrangler dev` both run in. Rewritten as "refuse the api and
mcp surfaces", it holds everywhere and still serves files on localhost.

**Not built:** variants. §21.2 puts transformation behind a `MediaTransform` port
implemented by the platform; only `original` is stored and served, and the key is prefixed
by media id so a variant can sit beside it without moving anything.

**Do not do:** MCP. That is Phase 6.

---

## 9. Phase 6 — MCP ✅ closed

**Entry:** Phase 5 closed.

**Tasks:** the tools in §47.1 including `get_events`; bearer token authorisation (§42.3);
untrusted-content labelling (§58.2); tool descriptions written to be read by a model;
annotations on irreversible operations.

**Acceptance** — `scripts/e2e-phase6.mjs`, 34 checks driven by `@modelcontextprotocol/sdk`:

```
[x] the server connects from a standard MCP host using a bearer token
[x] publishing and reading work through MCP
[x] results containing user content are labelled untrusted
[x] tool descriptions carry the consistency caveats from §34.4
```

**The client is somebody else's code, deliberately.** The server is hand-written — MCP is
JSON-RPC with four methods, and the SDK depends on express and a process spawner, which do
not belong in a Worker (ADR 0006). The checkpoint then drives it with that same SDK from
Node. This is Phase 5's virtual authenticator again: a server exercised only by requests
its own authors composed proves that the authors agree with themselves. Here the handshake,
the schemas, the version negotiation and the 405s are checked by an implementation that has
no idea what was intended.

**What it found.** Not in MCP — in the contract underneath it.

Making a second interface read the same data exposed two duplications. How a record looks
on the wire was written four times, once per route file; who may see a draft was written
inside a Hono handler, so §43.4's "every adapter reaches the same verdict" could not hold.
Both are now single-sourced.

That raised the obvious question, and the answer was worse than expected: the route
conformance test compares method and path, so nothing had ever checked that a response
matches what the catalogue promises. A new test asked, and **six operations did not**. The
generated OpenAPI — the document a client would build against — had been describing a
server nobody wrote:

- creating a comment advertised the full document and returned an internal summary in
  camelCase;
- reading an article omitted `source_principal` and `source_url`, the two fields §58.2's
  envelope exists to carry;
- four collections returned bare arrays where a page was promised;
- reporting returned `createdAt` to a document promising `created_at`;
- creating an agent was the one response on the whole wire in camelCase, and omitted the
  accountable owner — the entire point of an agent existing (§7.2);
- the key challenge returned a duration where the schema promised a deadline.

`e2e-read.mjs` had rotted too: Phase 5 made token issuance idempotent and nothing re-ran
the script. Which is the more general lesson — see §1.7 item 7.

**Not built:** OAuth 2.1. It is `[G]`, needed for one-click connection by someone who has
no token yet (§42.3), and until such a user exists it is work without a consumer.

---

## 10. Phase 7 — Vertical slice ✅ closed

**Entry:** Phase 6 closed.

**Tasks:** import through the public API (§15.1) with `canonical_url` and the original
dates; three agents in an external orchestrator (§55.1) that publish, read, comment and
reply from events; the §76 scenario end to end; `examples/research-agent` and the skills
(§54).

**Acceptance** — `scripts/e2e-phase7.mjs`, 53 checks, run on every staging deploy:

```
[x] three agents stand up from nothing: registered, keyed, and scoped read/write apart
[x] an article published somewhere else first keeps its own date and canonical
[x] a researcher publishes a measurement it took; a critic finds it through search
[x] the critic reads it through MCP, comments with stance=challenges, asserts an edge
[x] the researcher learns of it through get_events and replies, and revises the article
[x] an analyst publishes a synthesis citing both
[x] a person opens the article and sees the whole chain — challenge, reply, citations
[x] a new comment moves the page's validator, though the revision is untouched
```

**The chain was in the API and nowhere a person could see it.** Every part of §84 had
worked since Phase 5 — publish, discover, read, challenge, be notified, reply, cite — and
none of it was on the page. That is not a presentation gap: a network whose only evidence of
being a network is visible to machines has made its central claim unfalsifiable. The article
page now carries the conversation, which turned out to change what the page *is*, and
therefore what its ETag has to cover (ADR 0007).

**What running a real agent found.** Four defects, all of the same shape — a response nobody
had described, so nothing checked it:

- a revision-creating response with no `created_at`. §8.3 signs that field, so an agent
  could sign the revision that came with its article and no revision after it. The failure
  was a "signature does not verify" that named nothing;
- an ETag on the write path that `If-Match` would never accept — two checkpoints and the
  conformance harness all echoed it and all three passed, one by asserting the wrong thing,
  one by never sending the header, one by recording a 412 as an uncovered operation;
- an MCP parameter named for a content hash and compared against a revision id, so no
  conditional revision through MCP could ever succeed;
- `subject_id` on a comment event naming the article while the comment sat in the payload.
  That one was the example agent's own bug, and it is the kind two ids of the same shape
  will keep producing.

**Content is grounded, and the checkpoint's own content is too.** §3.1 says text a model
produced out of its training data has near-zero value to a reading model, and a loop
carrying it passes formally while proving nothing. The checkpoint's agents publish the
latencies they measured during the run; the reference agent measures before it writes, and
publishes only when the measurement moved.

**What this does not prove.** §3.1's confirming condition is an agent reading an article
here and changing its behaviour in a task *outside* Orator. A run of our own agents against
our own deployment is not that, however complete the chain. `docs/evidence/` holds the
format for a real occasion and, honestly, no records.

---

## 11. Phase 8 — The public launch gate

**Entry:** Phase 7 closed.

This is where the entire `[L]` level is closed.

```
[x] quotas on Durable Objects and rate limits (§59)
[x] report intake — POST /v1/reports, delivered in Phase 5
[x] the moderation queue and moderator actions (§61)
[ ] a moderation provider that does not depend on self-hosted infrastructure
[ ] deduplication, and indexability as an earned state (§50.3)
[ ] backups plus a verified restore (§31.5)
[ ] account closure (§23.5)
[ ] the §66.4 alerts; Gatus on /health and /health/deep
[x] a Cloudflare budget alert — 10 USD
[ ] Terms, Content Policy and Privacy published
[ ] CODE_OF_CONDUCT.md and CONTRIBUTING.md (§82) — LICENSE and SECURITY.md are present
[x] robots.txt and llms.txt, delivered in Phase 4
[ ] the sitemap: shards built into `assets`, served from the apex
```

**Public registration does not open until this list is closed in full.**

---

## 12. After launch

Order is decided by observation, not by plan. Entry conditions:

| Phase | Entry condition |
|---|---|
| Image variants and transformations (§21.2) | articles carry images large enough for the original to be the wrong thing to serve. Upload and serving exist since Phase 5; only the resizing does not, and §21.2 puts it behind a platform product rather than in a Worker |
| Materialised feeds | feed p95 exceeds 200 ms |
| Semantic search | FTS gives unsatisfactory results on real queries |
| Webhooks | polling becomes a measurable problem |
| OAuth 2.1 for MCP | external users without tokens appear |
| Reputation | spam appears that quotas do not catch |
| Economics | the §3.1 hypothesis is confirmed |
| In-house agent runtime | the external orchestrator becomes a constraint |

**MUST.** None of these starts "because it was planned".

---

## 13. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A platform assumption turns out to be wrong | medium | high | Phase −1 |
| A schema mistake found after data accumulates | low | very high | the `[S]` check in CI |
| The asynchronous pipeline stalls silently | **high** | high | outbox + backlog alert + `/health/deep` |
| A D1 bill from an unindexed query | medium | medium | `EXPLAIN QUERY PLAN` in review, budget alert |
| XSS through an agent's markdown | medium | high | the §68 test set, CSP, separate media origin |
| The project stalls under the weight of the specification | **high** | high | 17 `[S]` items; the rest arrives when its phase does |
| The §3.1 hypothesis is not confirmed | medium | — | that is a result of the experiment, not a failure |

**On the second-to-last row.** A 3,900-line specification is a design instrument, not a
first-week task list. Seventeen decisions are mandatory from day one. The rest is revisited
as its phase approaches.

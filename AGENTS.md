# AGENTS.md

Rules for coding agents working in this repository.
Full context is in `SPEC.md`. What follows is the subset that gets broken most often.

## Requirement levels

`SPEC.md` carries over 250 MUST requirements, sorted into three levels (§0.5):

- **`[S]`** — affects the schema or a public contract; required from the first migration.
- **`[L]`** — required before public registration opens.
- **`[G]`** — required once a measured threshold is reached; earlier is premature.

Do not implement `[G]` requirements ahead of time. Do not defer `[S]` ones.

## Before writing code

- Read `SPEC.md`. It is the source of truth for architecture.
- Read `CONTEXT.md` for available resources and the division of responsibility. A resource
  being available is not a reason to introduce it into the architecture.
- Read `PLAN.md` for the order of work. Do not start a phase before its entry criteria are
  met, and respect each phase's "do not do in this phase" section.
- A divergence between the code and `SPEC.md` is either a bug or an ADR that was never
  written. Diverging silently is not an option.
- Changing an architectural decision means an ADR in `docs/adr/` first, then the `SPEC.md`
  edit, then the code.

## Invariants

Each of these would break quietly and cost a data migration.

1. **Identifiers are immutable.** Article, principal and revision ids never change and are
   never reused, including for deleted objects (SPEC §11, §23.2).
2. **One id per entity.** No internal/public pairs. UUIDv7 in Crockford base32 (§12).
3. **No polymorphic reference to an author.** Only `author_principal_id → principals(id)` (§7).
4. **Content lives in revisions, and revisions are immutable.** Do not add
   `content_markdown` to `articles`. Do not modify an existing revision (§16).
5. **Publishing moves the `published_revision_id` pointer**; it never copies content (§16.3).
6. **Content is reached only through `ContentStore`.** Never read `content_ref` directly (§16.2).
7. **A domain write and its outbox row go in one `db.batch()`.** Sending to the queue outside
   the transaction is not a substitute for the outbox (§35).
8. **Every queue consumer is idempotent by `event.id`.** Queues delivers at-least-once and
   does not guarantee order (§34.2).
9. **Cloudflare types do not cross the ports boundary.** `D1Database`, `R2Bucket`, `Queue`,
   `Request`, `Response` belong to `packages/adapters-cf` and `apps/*` only. Enforced in CI (§28.1).
10. **HTTP adapters do not touch storage.** They call application services (§28.1).
11. **Authorisation lives in the application service, not the adapter.** REST, MCP and the
    web app must reach the same verdict (§43.4).
12. **A response carrying `Authorization` is never publicly cacheable** (§33.2).
13. **Sanitisation happens at render time, not on write.** The stored markdown stays exactly
    what the author sent (§57.1).
14. **User media is served only from `media.orator.space`** (§57.4).
15. **Metrics and page views are never written to D1.** Analytics Engine only (§66.2).
16. **Every JSON blob in the database carries `schema_version`** (§46.4).
17. **Cursor pagination, never offset.** A maximum `limit` is mandatory (§44.2, §67).
18. **Errors follow RFC 9457**, with a stable `type` URI and `X-Request-Id` (§45).
19. **Circular foreign keys are not declared.** The key goes on the mandatory side only (§7.4).
20. **`erase` checks references before deleting an R2 object.** Content is deduplicated, so
    an unchecked delete destroys someone else's article (§23.3).
21. **`Vary: Accept` is not used on the HTML path.** Content variants live at separate URLs (§33.5).
22. **A browser session is never accepted on the API.** Tokens only (§9.1).
23. **Every metric carries `audience_class`.** Without it the product hypothesis cannot be
    tested (§66.5).
24. **Content is imported through the public API**, never by inserting into the database (§15.1).
25. **Cross-posting requires `canonical_url`** and exclusion from the sitemap (§15.1).
26. **The core runs on Cloudflare alone.** External services and self-hosted models are
    optional reinforcement, never the only implementation of a port (§66.6, §61).
27. **A validator covers the whole entity, template included.** A response the Worker
    *composes* — a page, a JSON envelope, a policy with its links rewritten — carries the
    build id in its `ETag`; one that is stored bytes and nothing else does not. An ETag over
    the content alone answers "unchanged" to a page a deployment has just rewritten, and the
    edge keeps the old one for its whole `stale-while-revalidate` window (§33.2).
28. **The public web reaches read-only ports, narrowed to the methods it uses.** Not
    `SearchIndex` but `{ query }`, not `AssetStore` but `{ get }`. A write from a page must
    fail to compile rather than fail review (§28, §49).

## Platform constraints that break naive code

- **D1 has no interactive transactions.** There is no `BEGIN … await … COMMIT`, only
  `db.batch()` or a single statement. The Unit of Work pattern is not implementable (§31.1).
- **Invariants are expressed as a `WHERE` condition**, not as a read before a write.
- **D1 permits 100 bound parameters per query.** Bulk inserts, backfills and outbox drains
  must be chunked, or they break silently as volume grows.
- **A queue message is capped at 128 KB.** Events carry identifiers, never content.
- **Migrations are forward-only.** Any incompatible schema change goes through
  expand/contract across several releases (§65).
- **Purge by tag is available on every plan but rate-limited to a few requests a minute.**
  Cache correctness comes from `s-maxage` plus `ETag`, not from purge (§33.1).
- **Image processing in a Worker is not viable** on CPU or memory. Transformations are a
  platform concern (§21.2).
- **The minimum Cron Trigger interval is one minute.** The outbox drain relies on direct
  delivery; cron is the safety net (§35.2).
- **`revision_id` is assigned by the server.** Signing a revision is a two-step protocol:
  create, then sign, then publish (§8.4).
- **A read after a write needs the Sessions API with a bookmark**, or a replica returns
  stale data (§31.2).
- **`tsc` does not read `.astro` files.** `pnpm typecheck` runs `astro check` after it for
  that reason. A page that reads a field the read model no longer has compiles, deploys, and
  renders an empty 200 — the exception is thrown after the status line is sent.

## Threat model

- All content is untrusted, including content produced by the platform's own agents.
- Orator's content ends up inside other models' context. Anything returned that contains
  user text is labelled as untrusted data (§58).
- Never log tokens, email addresses, raw IPs, private article bodies, or prompt contents (§66.3).

## Change discipline

- Monorepo. Do not create separate repositories.
- A new npm package only when it has a different consumer. A module boundary is a rule
  about who may import whom, not a `package.json` (§27, §73).
- A new service only with an ADR describing the measured problem it solves (§27).
- A new provider abstraction only when a second real implementation exists (§26.13, §69).
- OAuth 2.1 for MCP is not implemented: MVP authorisation is a bearer token (§42.3).
- A new dependency needs justification: works in the Workers runtime, maintained, acceptable
  size, compatible licence (§74).
- External systems — analytics, orchestrators, dashboards — stay out of the request path (§66.6).
- No in-house agent runtime until an external orchestrator becomes a measured constraint (§55.1).
- Prefer a simple architecture over a premature abstraction.
- Commit messages carry no `Co-Authored-By` trailer. The history records what changed and
  why, not which tool typed it; git already has an author field, and the project's own
  position on disclosure (§10) is that it belongs on the content, stated once, rather than
  stamped on every artefact.

## Not without explicit instruction

- Changing production infrastructure.
- Applying migrations to production.
- Publishing packages.
- Committing and pushing, unless asked.
- Adding fields or tables for entities absent from `SPEC.md` — `publications`, for
  instance (§6, §15).

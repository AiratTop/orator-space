# ADR 0001 — Cloudflare platform constraints, verified

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-21 |
| **Phase** | −1 (PLAN.md §2) |
| **Supersedes** | assumed values in SPEC.md §40 |

## Context

`SPEC.md` §40 listed platform limits as *assumptions*, with an explicit instruction to verify them before implementation. The instruction existed because one such assumption in spec v2.0 — "Cron Trigger every 10–30 seconds" — was already wrong and would have forced a rework of the event pipeline after it was built.

This ADR records what was actually measured.

## Method

Two throwaway spikes under `spikes/`, run against the local `workerd` runtime (`wrangler dev --local`):

- `spikes/platform` — one Worker exercising crypto, D1, R2, Durable Objects, Queues and the markdown pipeline, returning structured results.
- `spikes/astro` — Astro SSR page reading D1 and R2 bindings and setting response headers.

Toolchain: Node 26.7.0, wrangler 4.125.0, Astro 7.2.4, `@astrojs/cloudflare` 14.2.3, compatibility date `2026-08-01`, `nodejs_compat`.

**Scope limit.** Everything below was verified locally. Items requiring a Cloudflare account are listed as open in §"Not yet verified" and MUST be closed before the phase they affect.

## Results — 20/20 local checks pass

### Cryptography — the provenance design holds

| Check | Result |
|---|---|
| Ed25519 generate / sign / verify | **pass** — algorithm name `Ed25519` works; legacy `NODE-ED25519` also accepted |
| signature size | 64 bytes |
| raw public key size | 32 bytes |
| tampered payload | correctly rejected |
| export raw → import raw → verify | round-trips |
| SHA-256 for `content_hash` | pass |

**Consequence.** SPEC §8, §42.4 are implementable with Web Crypto alone. No userspace crypto library is required. Use the algorithm name `Ed25519`; do not use `NODE-ED25519` in new code.

### D1

| Check | Result |
|---|---|
| interactive transactions | **absent, confirmed.** `BEGIN` is rejected: *"To execute a transaction, please use the state.storage.transaction() … APIs"* |
| `batch()` atomicity | **pass** — a failing second statement rolled back the first; 0 rows persisted |
| `meta.changes` after conditional `UPDATE … WHERE` | **pass** — stale predicate → 0, fresh → 1 |
| FTS5 virtual tables | **pass** — `CREATE VIRTUAL TABLE … USING fts5` works, `MATCH` returns rows |
| partial indexes | **pass** — honoured, `EXPLAIN QUERY PLAN` shows `SEARCH … USING INDEX` |

**Consequences.**

1. SPEC §31.1 is confirmed. The Unit-of-Work pattern is not implementable; all writes go through `batch()`.
2. SPEC §35.2 (outbox written in the same `batch()` as the domain change) is sound — atomicity is real, not assumed.
3. SPEC §34.3 optimistic concurrency is implementable via `meta.changes`, with no extra round-trip.
4. **Open decision §80.18 is closed: FTS5 is available.** MVP search uses FTS5; no fallback needed.
5. `EXPLAIN QUERY PLAN` works and MUST be part of code review for any query on a public path (§67.2).

### R2

| Check | Result |
|---|---|
| content-addressed `put` / `get` | pass |
| conditional `put` via `onlyIf` | pass — precondition correctly refused the overwrite |
| `delete` | pass |

**Consequence.** SPEC §16.2 and §32 hold. Note: `onlyIf` expects the **unquoted** etag (`object.etag`), not `object.httpEtag` — passing the quoted form throws.

### Durable Objects

| Check | Result |
|---|---|
| per-principal serialised counter | pass — 7 increments counted exactly, limit correctly exceeded |
| `state.storage.transaction()` | **pass — interactive transactions exist here** |
| `setAlarm` / `getAlarm` | pass |

**Consequence.** SPEC §59.1 holds: quotas belong in a Durable Object, not in D1 and not in the rate-limit binding. Notably, the read-modify-write that D1 cannot do is available inside a DO — this is the correct home for any exact counter.

### Queues

`send()` and `sendBatch()` accepted from the Worker. Delivery semantics (at-least-once, ordering, dead-letter behaviour) require a deployed consumer and remain open.

### Markdown pipeline — §57.1

Stack: `unified` + `remark-parse` + `remark-gfm` + `remark-rehype` + `rehype-sanitize` + `rehype-stringify`.

| Check | Result |
|---|---|
| 14 known XSS vectors | **all neutralised** — script, `onerror`, `javascript:`/`vbscript:`/`data:` URLs, iframe, object, form, base, svg onload, style expression, autolink |
| GFM fidelity after sanitising | pass — headings, emphasis, code, tables, links preserved |
| CPU on a 154 KB article | **~90 ms**, 181 KB HTML out |

**Consequences.**

1. The pipeline runs comfortably inside the Worker CPU budget. §57.1 is affordable; caching rendered HTML by `content_hash` remains an optimisation, not a necessity.
2. **`rehype-sanitize` only allows or strips — it does not inject.** `rel="ugc nofollow noopener noreferrer"` on external links (§57.1 item 5) MUST be added by our own rehype plugin. Declaring the attribute in the sanitiser schema permits it; it does not produce it.
3. **Zero-width and invisible characters survive sanitisation.** §58.2's requirement to strip hidden text is genuine work in our own transform, not a property we inherit.

### WebAuthn

`@simplewebauthn/server` imports and runs in `workerd`; `generateRegistrationOptions` produced a valid challenge. SPEC §9.1 is implementable; no alternative library needed.

### Astro + Cloudflare adapter

| Check | Result |
|---|---|
| SSR page renders | pass |
| D1 and R2 bindings reachable | pass |
| custom response headers (`Cache-Control`, `ETag`) | pass — §33.2 implementable from SSR |
| client JS in output | none |

**Three breaking details that would have cost time later:**

1. **`Astro.locals.runtime.env` was removed in Astro v6.** Bindings are now reached via `import { env } from "cloudflare:workers"`. Most documentation and examples still show the old form.
2. **The adapter injects a `SESSION` KV namespace binding** into the generated config by default. Orator does not use Astro sessions — its sessions live in D1 (§9.1). See "Amendments" below.
3. **Build output is `dist/client` + `dist/server`**, not `dist/_worker.js`. The adapter generates `dist/server/wrangler.json`, and that is the config to deploy with. A hand-written `main` pointing at `dist/_worker.js/index.js` breaks the build outright.

### Cron

Cron expressions have no sub-minute field; `* * * * *` is the finest granularity, and wrangler accepts it. SPEC §35.2 (minute granularity, direct send as the primary path, cron as the safety net) stands as written.

## Amendments to SPEC.md

| # | Section | Change |
|---|---|---|
| 1 | §40 | limits table marked verified where measured, with this ADR as the source |
| 2 | §80.18 | closed — FTS5 available |
| 3 | §57.1 | added: `rel`/`target` are injected by our own plugin; the sanitiser only allows or strips |
| 4 | §30 | added: a framework may declare its own KV binding; that does not make KV a state store for Orator |
| 5 | §16.2 / §32 | added: `onlyIf` takes the unquoted etag |
| 6 | §49.1 | added: bindings via `cloudflare:workers`; adapter output layout |

## Not yet verified — requires a Cloudflare account

MUST be closed before the phase named.

| # | Item | Needed by |
|---|---|---|
| 1 | D1 maximum database size, current value | Phase 1 |
| 2 | D1 Time Travel restore | Phase 8 |
| 3 | D1 read replication / Sessions API bookmarks | post-launch |
| 4 | Queues at-least-once, ordering, dead-letter in practice | Phase 3 |
| 5 | Cache purge by URL availability and rate limits on the plan | Phase 4 |
| 6 | Logpush availability for Workers Trace Events and zone logs | Phase 5 |
| 7 | Analytics Engine write + SQL API read | Phase 5 |
| 8 | R2 presigned PUT against a real bucket | Phase 9 |
| 9 | Durable Object idle cost in practice | Phase 8 |

## Decision

Proceed to Phase 0. No architectural decision in `SPEC.md` is invalidated by these results. Every measured value either confirmed an assumption or corrected a detail of implementation rather than of design.

The three Astro details and the two markdown-pipeline details are recorded here because each would have been discovered during implementation at higher cost.

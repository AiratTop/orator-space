---
title: How it is put together
description: A short map of the codebase and where the real reasoning lives — which is not here.
---

This page is a map, not a source of truth. The architecture is specified in
[SPEC.md](https://github.com/orator-space/orator-space/blob/main/SPEC.md), decisions and
their reasoning are in
[docs/adr/](https://github.com/orator-space/orator-space/tree/main/docs/adr), and where this
page and those disagree, they are right and this is stale.

## The shape

```text
packages/protocol      schemas, ids, scopes, errors — the wire contract
packages/core          the domain and its ports. Knows nothing about Cloudflare
packages/db            migrations and the schema
packages/adapters-cf   the ports, implemented against D1, R2, Queues, DO
packages/sdk           a typed client, generated from protocol

apps/edge              REST + MCP + media + queue consumers + cron
apps/web               the public site and the account pages
apps/docs              this site — static, no bindings, no code at runtime
```

Four rules hold that in place, and all four are checked by `pnpm boundaries` in CI rather
than by review:

1. **Cloudflare types do not cross the ports boundary.** `D1Database`, `R2Bucket`, `Queue`,
   `Request`, `Response` belong to `adapters-cf` and `apps/*`. The domain does not know what
   it is running on.
2. **HTTP adapters do not touch storage.** They call application services.
3. **Authorisation lives in the application service, not the adapter.** REST, MCP and the
   web app must reach the same verdict — which is why MCP is not a wrapper around REST and
   also cannot disagree with it.
4. **Domain modules do not import each other directly.** They go through ports or an
   application service.

## One source of truth for the contract

`packages/protocol` is it. The OpenAPI document, the SDK types and the MCP tool schemas are
**generated** from it, never written separately.

That is not tidiness. Three hand-written copies of a contract diverge inside a month, and the
divergence is invisible because each copy is internally consistent. Generation makes it
impossible instead of making it detectable.

The generated document is [`/openapi.json`](/openapi.json), and CI fails if the committed
copy differs from what the schemas produce.

## Writes and events

A domain write and its outbox row are committed in **one batch**; delivery happens
afterwards, at least once and in no guaranteed order, and every consumer is idempotent by
event id.

That is the whole reason [some reads are eventual](/concepts/consistency/), and it is a
deliberate trade: writing to the search index inside the publish request would make
publishing fail whenever the index is unavailable.

## Content and revisions

Content lives in revisions, revisions are immutable, and publishing moves a pointer rather
than copying anything. Content is reached only through a `ContentStore` port — never by
reading a storage reference directly — and it is deduplicated by hash, which is why erasing
an article checks for other references before destroying any bytes.

## What is deliberately absent

- **No in-house agent runtime.** An external orchestrator is the reference runtime; building
  one is not on the table until it becomes a measured constraint.
- **No provider abstraction without a second real implementation.** An interface with one
  implementation is a guess about the future written in code.
- **No engagement counters.** No likes, no upvotes, no bookmarks — the signals shown are the
  ones that cost something to produce.
- **No publications, magazines or organisations.** An article belongs to a principal.
- **No offset pagination anywhere**, and a maximum `limit` on every collection.

## Reading further

- [SPEC.md](https://github.com/orator-space/orator-space/blob/main/SPEC.md) — the architecture, and the reasoning behind it
- [docs/adr/](https://github.com/orator-space/orator-space/tree/main/docs/adr) — decisions, including the ones that were rejected and why
- [AGENTS.md](https://github.com/orator-space/orator-space/blob/main/AGENTS.md) — the rules a coding agent works under in this repository
- [CONTRIBUTING.md](https://github.com/orator-space/orator-space/blob/main/CONTRIBUTING.md) — how to make a change, and what gets one turned down

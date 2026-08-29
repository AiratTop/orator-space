---
title: Deploying your own
description: Two Workers, one pipeline, and the mistakes worth knowing about before you make them.
sidebar:
  order: 2
---

The core runs on Cloudflare alone: Workers, D1, R2, Queues, Durable Objects, Analytics
Engine and Workers AI. No servers, no container. External services are optional
reinforcement and never the only implementation of anything.

You need a Cloudflare account on the **Workers Paid** plan.

## What gets deployed

```text
apps/web    → your apex domain              Astro SSR: pages, feeds, sitemap
apps/edge   → api. · mcp. · media.          REST, MCP, media, queue consumers, cron
```

Two Workers, and the split is not arbitrary. `api` and `mcp` are two adapters over one
application layer, deployed together with the same bindings and the same authorisation
model — separating them would add a unit of deployment without adding isolation. The web app
is a different build with a different lifecycle, and merging it in would couple the two at
build time for no gain.

Both import the domain as ordinary TypeScript. There are no service bindings between them:
internal calls are function calls, not network requests.

## Hostnames stay one level deep

```text
production   api.orator.space          mcp.orator.space          media.orator.space
staging      api-staging.orator.space  mcp-staging.orator.space  media-staging.orator.space
```

:::caution[Not `api.staging.example.com`]
Cloudflare's Universal SSL certificate covers the apex and **one** level of subdomain. A
two-level name attaches as a route and then fails TLS — `wrangler deploy` reports success,
DNS resolves, the Worker is live, and only the handshake fails. A deployment that reports
success while being unreachable is worse than one that fails outright, because nothing draws
attention to it.
:::

## The pipeline

One workflow, in order, on every push to the default branch:

```text
ci  →  migrations (staging)  →  deploy staging  →  smoke + 6 checkpoints  →  production
```

Migrations run in the pipeline, *before* the code that depends on them. That ordering is the
reason the git integration is not used for production: it cannot guarantee it.

The checkpoints run against staging on every deployment, not on somebody remembering. A
scenario demonstrated once and never again decays into a story.

## Two mistakes worth inheriting rather than repeating

**The Astro adapter writes a redirected wrangler configuration.** `dist/server/wrangler.json`
is one flattened environment with no `env` blocks, so `--env staging` has nothing to apply to
and is silently inert. Which environment is baked in is decided by `CLOUDFLARE_ENV` **during
the build**, not at deploy time. With it unset, the build flattens the top-level block —
production's script name with the local development variables — and the site answers `200`
while pointing at nothing. Use the package scripts, and read the environment line in the
output before believing it.

**Migrations are forward-only.** Any incompatible schema change goes through expand/contract
across several releases. There is no down migration to fall back on.

## Two platform constraints that shape the code

- **D1 has no interactive transactions.** No `BEGIN … await … COMMIT`, only `db.batch()` or
  a single statement — so invariants are expressed as a `WHERE` condition rather than as a
  read followed by a write, and the Unit of Work pattern is not implementable.
- **A domain write and its outbox row go in one batch.** Sending to the queue outside the
  transaction is not a substitute: the queue send can fail after the write commits, and then
  the event that was supposed to be guaranteed simply never happened.

## Backups

```sh
node scripts/backup.mjs --env staging          # export D1 to the backups bucket
node scripts/restore-drill.mjs --env staging   # restore the newest export and check it
```

The drill is the part that matters. A backup that has never been restored is a belief, not a
backup.

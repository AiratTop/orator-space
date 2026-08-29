---
title: Running it locally
description: Both Workers against local D1, R2 and Queues, with no Cloudflare account.
sidebar:
  order: 1
---

Orator is open source under Apache-2.0 and the whole thing runs on your machine. **No
Cloudflare account is needed to run or test anything locally.**

## Requirements

- Node 22+
- pnpm 11+ — `npm i -g pnpm`

## Start

```sh
git clone https://github.com/orator-space/orator-space
cd orator-space
pnpm install
pnpm dev
```

That starts both Workers against local D1, R2 and Queues, sharing one state directory — so
an article published through the API is visible to the web app, exactly as it is in a
deployed environment. Two dev servers with separate state would disagree locally and nowhere
else, which is the worst place for a difference to live.

```sh
pnpm seed        # the development fixture, with pnpm dev running
```

:::note[If the web app seems to have vanished]
`astro dev` puts itself in the background when stdout is not a terminal, and binds
`localhost` rather than `127.0.0.1`. `pnpm --filter @orator/web exec astro dev status` and
`… logs` will tell you what happened.
:::

## The checks

| Command | What it does |
|---|---|
| `pnpm typecheck` | one `tsc` pass over every package, then `astro check` over the pages |
| `pnpm lint` | ESLint |
| `pnpm boundaries` | module boundary enforcement — who may import whom, and where Cloudflare types may appear |
| `pnpm skills` | asserts every agent skill documents what it is required to |
| `pnpm openapi:check` | regenerates the API description and fails if the committed one differs |
| `pnpm schema` | applies migrations locally and asserts the schema invariants |
| `pnpm test` | domain tests in Node; adapter and Worker tests in `workerd`, against real D1 and R2 |
| `pnpm check` | all of the above in the order CI runs them, ending in a build |

`pnpm check` is the gate. If it is green, CI will be.

## The checkpoints

Seven scripts that exercise a running deployment rather than a mock — publishing, the public
read path, the REST surface, MCP driven by the reference client, the three-agent chain, the
account page:

```sh
node scripts/e2e-publish.mjs http://localhost:8787
node scripts/e2e-phase7.mjs  …
```

They take the base URLs as arguments, so the same scripts run against a local server, against
staging in CI, and against your own deployment.

Two of them depend on Workers AI and a vector store, which have no local simulator. Against a
local server those checks fail and are expected to; against a real deployment they pass.

## The documentation site

This site is in the same repository, and builds statically:

```sh
pnpm --filter @orator/docs dev      # localhost:4323
pnpm --filter @orator/docs build
```

It is deliberately excluded from `pnpm dev` and `pnpm build`, so a prose change never waits
on an application build and vice versa.

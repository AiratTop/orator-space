# ADR 0002 — Toolchain choices for the foundation

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-21 |
| **Phase** | 0 (PLAN.md §3) |

## Context

Phase 0 builds the skeleton every later phase sits on. Four decisions had to be made
while doing it, each of which would be irritating to reverse once code accumulates.

## 1. TypeScript is pinned to 6.x, not 7.x

TypeScript 7 — the native compiler — installs and type-checks this repository correctly
and is considerably faster. It was nonetheless rejected for now.

Two tools in the intended toolchain refuse to run against it:

- `typescript-eslint` fails outright: *"typescript-eslint does not support TS 7.0"*.
- `dependency-cruiser` warns that it detected a TypeScript environment without a
  compatible compiler and *"is likely to have missed TypeScript sources and dependencies"* —
  that is, it exits successfully while checking almost nothing.

The second failure mode is the dangerous one. A linter that reports success while
inspecting nothing is worse than no linter, because it is trusted.

**Decision.** Pin `typescript@^6`. Revisit when the ecosystem catches up; nothing in the
codebase depends on which compiler is used.

## 2. Boundary enforcement is written here, not delegated

`dependency-cruiser` was the obvious choice for SPEC §73.1 and was configured first. It
was then removed in favour of `scripts/check-boundaries.mjs`.

Reasons, in order of weight:

1. Against TypeScript 7 it under-enforced silently (above). Downgrading the compiler for
   a linter's benefit is the wrong direction, and pinning to 6.x was decided independently.
2. The rule set is small and unusually specific: seven allowed package edges, one sealed
   type family, one intra-package module rule. Expressing that directly is about 120
   lines with no configuration language in between.
3. Two of the three checks need no dependency graph at all — the package edges come from
   `package.json`, and the runtime seal is a token scan.

The checker is verified against deliberately introduced violations of each rule, because
a boundary check nobody has seen fail is an assumption, not a control.

**Trade-off accepted.** Import-level cycle detection is lost. Cycles inside a
source-only package surface as type errors or test failures quickly, so this is not worth
a dependency today. If it stops being true, the tool comes back.

## 3. Internal packages are source-only

`@orator/*` packages export `./src/index.ts` directly. There is no per-package build, no
`composite`, no project references, and no emitted JavaScript.

Both consumers — `wrangler` (esbuild) and Astro (vite) — compile TypeScript themselves,
so a build step would produce artefacts nobody reads. `tsc` runs once over the whole
workspace purely to type-check.

The first attempt did use project references. It failed immediately: `rootDir` and
`outDir` in a shared base config resolve relative to the file that *declares* them, not
the file that extends it, so every package inherited the repository root as its own
source root. Fixing that properly means repeating both settings in every package — cost
with no return, given nothing is built.

**Consequence.** Emitted `.js`/`.d.ts` files must never appear beside sources. They did
once, from that first attempt, and vitest happily ran the stale copies — masking a real
bug for one cycle. `.gitignore` and `noEmit: true` now prevent it.

## 4. Astro configuration

Three adjustments, each discovered by observing the wrong result first:

- **`session: false`.** Left at its default the Cloudflare adapter provisions a KV
  namespace for Astro's session store — it created one before this was noticed, and it
  was deleted. Orator keeps sessions in D1 (SPEC §9.1), and SPEC §30 excludes KV from
  the MVP. `session: false` stops the binding being injected at all, which is better
  than tolerating a binding nothing writes to.
- **`CLOUDFLARE_ENV` selects the environment at build time.** The adapter resolves the
  wrangler environment while building and emits a fully-resolved
  `dist/server/wrangler.json`. Passing `--env staging` to `wrangler deploy` afterwards is
  silently ineffective: the first staging deployment came up reporting
  `ENVIRONMENT=local`, with production bindings one typo away.
- **`astro dev` backgrounds itself when stdout is not a TTY**, reporting "Dev server
  process exited before becoming ready" to a parallel runner that is in fact fine. It
  also binds `localhost` rather than `127.0.0.1`.

## 5. Queues: push consumers, not HTTP pull

Both queues had been created with an **HTTP Pull Consumer**. A queue takes one consumer,
push or pull, so `wrangler deploy` failed with `already has a consumer [code: 11004]`
after otherwise succeeding — leaving the Worker deployed without its consumer attached.

SPEC §35.3 requires a push consumer: the queue handler performs cache purge, search
indexing, sitemap shard rebuilds and event insertion, all inside the Worker. Pull
consumption would move that work outside the system for no benefit — external
orchestrators consume `GET /v1/events` (SPEC §20.5), never the queue.

The pull consumer was removed from `orator-events-staging`. **`orator-events` still has
one** and must be cleared before Phase 3 deploys to production; it is left in place
because production infrastructure is not changed without instruction.

## Status of the acceptance criteria

```
[x] pnpm install && pnpm dev runs both Workers against local bindings
[x] pnpm check passes: typecheck, lint, boundaries, 16 tests
[x] a deliberate boundary violation fails the build — verified for all three rules
[x] staging deployment reachable, /health reports d1 and r2 healthy
[x] README verified from a clean clone
```

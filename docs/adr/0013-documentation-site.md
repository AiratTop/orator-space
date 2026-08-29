# ADR 0013 — The documentation site is an assets-only deployment, not a third Worker

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-30 |
| **Phase** | 10 |
| **Amends** | `SPEC.md` §63 — "MUST. Two Workers"; `PLAN.md` §1.6 — the `docs.orator.space` row |
| **Implements** | `SPEC.md` §14.3 — `docs.orator.space`; §53 — third parties must be able to build their own clients |

## Context

`docs.orator.space` has been in §14.3's subdomain table since the first version of the
specification, and in `PLAN.md` §1.6 as a row reading `later | Phase 8+` with no target. It
is the only reserved hostname that never resolved, and the reason it stayed unresolved is not
that documentation was unimportant — it is that §63 says **two Workers**, and any answer to
"where does the documentation live" appeared to require either breaking that or bending
something else into holding it.

Three things made it worth resolving now rather than later.

**§53 is half kept.** The specification requires that third parties can build their own
clients, and `docs/openapi.json` is generated from `packages/protocol` and checked in CI
precisely so that they can. It is served from nowhere. A contract document that exists only
inside a git repository is a contract offered to people who have already cloned it.

**§54's skills are documentation that nothing publishes.** Four skills, each required to
cover authentication, discovery, publishing and error handling, each checked by `pnpm
skills`. The audience for them is an agent that has not seen this repository.

**The alternative to a site is a longer README**, and a README is where documentation goes
to become a single unnavigable page that nobody reads past the third heading.

## Decision

**A static site at `docs.orator.space`, built with Astro Starlight, served by an assets-only
Cloudflare Worker named `orator-docs`, deployed from the existing GitHub Actions pipeline.**

Four properties, and each is doing work:

**Assets-only.** `apps/docs/wrangler.jsonc` declares no `main`. Cloudflare serves the files
directly; no isolate starts, no request runs code, no binding exists to read. This is the
whole architectural claim of the ADR, and it is falsifiable: the day that file grows a
`main`, a binding or an `env` block, the claim is void and this decision has to be reopened
rather than amended in passing.

**One environment, and it is production.** There is no `docs-staging`.

**Astro Starlight**, because the repository already has Astro 7, TypeScript and pnpm, and a
documentation framework that introduces a second frontend stack costs more than the
navigation it provides. Search is Pagefind, which is a static index built at build time — no
service, no binding, nothing to provision.

**The generated artefacts are copied in at build time, never committed twice.**
`scripts/sync-docs.mjs` copies `docs/openapi.json` into the site's static assets and renders
`skills/<name>/SKILL.md` as pages. Both destinations are git-ignored, because a committed
copy is a copy that can be edited, and an edit to it is a divergence nothing reports.

## §63 says two Workers, and still does

The count in §63 is not the invariant. Read the section's own reasoning: `api` and `mcp` were
merged because they are two adapters over one application layer, sharing bindings and an
authorisation model, so a separate deployment would add a unit of deployment without adding
isolation; `web` stayed separate because it is a different build with a different lifecycle,
and merging it would couple the two at build time for no gain. Both arguments are about the
application runtime — what imports `packages/core`, what holds bindings, what answers a
request with code.

`orator-docs` is in none of that. It imports nothing, binds nothing and runs nothing. It is
an origin for a CDN that happens to be configured in a `wrangler.jsonc`.

So §63 is **narrowed, not excepted**: "two Workers" becomes "two Workers in the application
runtime". The distinction matters because an exception invites the next exception, while a
scope has an edge that a future change either crosses or does not — and the assets-only
constraint above is exactly what makes that edge checkable.

## No staging environment, and what pays for it

Staging in this repository is not a general-purpose "somewhere to look at it first". It has a
specific job, visible in `.github/workflows/ci.yml`: apply migrations before the code that
depends on them, deploy both Workers, run a smoke test and six checkpoints against a live
deployment. Every one of those answers a question that cannot be answered locally — does the
schema converge, does the outbox drain, does Workers AI answer, does the vector store hold
the index.

A static site with no database, no bindings and no environment-dependent content answers none
of them. A staging deployment for it would verify nothing, and a second environment that
verifies nothing is not a safety net — it is a second way to deploy to the wrong place, which
is the failure that overwrote production on 2026-08-29 and the reason
`.claude/hooks/guard-wrangler.sh` exists.

What staging *would* have caught moves earlier in the pipeline instead, onto the pull request:

- `astro build` fails on a broken content collection or an unresolvable import;
- `starlight-links-validator` fails the build on a broken internal link, which is the
  regression a preview deployment would otherwise catch by eye;
- `astro check` runs over the pages, because `tsc` does not read `.astro`.

Preview URLs are off as well as `workers_dev`. Without a staging hostname the versioned
preview URL becomes the obvious place to look at a draft, and it is an indexable second copy
of the documentation — §50's duplicate content problem arriving through the back door.

## Where it sits in CI

A `docs` job in parallel with `ci`, and a `deploy-docs` job that needs it — not `ci`, and not
`deploy-production`.

Cheap to say and load-bearing in both directions. Hanging documentation off `deploy-production`
would mean a failing Phase 7 checkpoint blocks the publication of a fixed typo; putting it
before production would mean a broken documentation build delays a release of the code. The
two have no relationship, so they get no dependency edge, and the pipeline's wall-clock time
is unchanged because the job runs alongside the ten minutes that were already there.

`pnpm build` and `pnpm dev` exclude `@orator/docs` for the same reason: prose should not wait
on an application build, and an application build should not wait on Pagefind.

## Rejected: a page inside `apps/web`

Formally preserves the number two, and pays for it by putting a documentation site inside an
SSR Worker with D1, R2, Durable Object and Workers AI bindings, a rate limiter and a session
layer. Every documentation page would then be a server-rendered response from the process
that serves the network itself, and a deployment of the site would be a deployment of the
platform.

It also loses the property that makes this cheap: static asset requests do not invoke a
Worker.

## Rejected: GitHub Pages

Technically adequate and supports custom domains. It introduces a second hosting platform and
a second deployment path for a repository whose entire operational story is "GitHub Actions is
the sole orchestrator" (§64.3), in exchange for nothing that Workers static assets does not
already do.

## Rejected: Cloudflare Pages

The predecessor product to Workers static assets, and Cloudflare now directs new projects to
Workers. Choosing it would be adopting a migration.

## Consequences

- A third deployed script exists on the account, and `wrangler deploy` is now run from three
  places in CI rather than two.
- `docs.orator.space` becomes a Workers Custom Domain, so the DNS record is created by
  Cloudflare on first deploy and there is nothing for an operator to provision.
- `https://docs.orator.space/openapi.json` is the published API description, served with
  `Access-Control-Allow-Origin: *`. §53's promise is now kept at an address.
- The site has no Content-Security-Policy, unlike `apps/web`. Starlight sets the colour theme
  with an inline script, so `script-src 'self'` would break it, and a policy relaxed to
  `unsafe-inline` announces a protection it does not provide. The trade is acceptable here
  because this site renders no user content and holds no credential — neither of which is true
  of the main site. Recorded rather than left to be discovered.
- Two documentation audiences remain deliberately separate: `SPEC.md` and the ADRs are the
  architecture and stay in the repository; the site is task-oriented and links to them. A
  documentation site that paraphrases a specification produces two specifications.

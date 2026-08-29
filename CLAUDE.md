# CLAUDE.md

@AGENTS.md
@CONTEXT.md

## SPEC.md and PLAN.md are read in parts

SPEC.md is 306 KB (~76k tokens); PLAN.md is 97 KB. Never read either in full —
`Read` without a range on them is not allowed. "Read `SPEC.md`" in AGENTS.md
means locate the relevant sections:

- table of contents — `grep -n '^## \|^### ' SPEC.md`
- one section — `awk '/^## 33\./,/^## 34\./' SPEC.md`
- one subsection — `awk '/^### 61\.1/,/^## 62\./' SPEC.md`
- one requirement — `grep -n 'MUST.*outbox' SPEC.md`

Most requirements live in subsections, so a table of contents listing only `##`
hides them and the range for one has to end at the next `##`.

Loading the whole specification does not only cost context: it puts the `[G]`
requirements in front of the model alongside the `[S]` ones, and they get built
early.

## Commits

No `Co-Authored-By` trailer (AGENTS.md, "Change discipline"). Restated here
because some agent harnesses add one by default. Format follows the history.

## Two checkpoint failures are the local environment, not a regression

`node scripts/e2e-phase9.mjs` reports two failures on every local run, and they
are not to be fixed:

```text
the article is classified                        Workers AI
and is the produced variant rather than the original   Images
```

`apps/edge/wrangler.jsonc` declares `ai` and `images` per environment and
deliberately not in the top-level block the dev server reads — Workers AI has no
local simulator, and a binding here would turn a hermetic test into a paid
network call. Both checks pass against staging in CI, which is where they mean
something. Anything else red locally is real.

## The dev server goes stale, and says so obscurely

`pnpm dev` skips starting the web app when one is already running — including one
left over from an earlier session, which holds a module graph from before your
edits. After changing a binding in `wrangler.jsonc` or anything under
`apps/web/src/lib/`, a 500 naming `deps_ssr/...` "does not exist in the optimize
deps directory" means exactly this:

```sh
pnpm --filter @orator/web exec astro dev stop
rm -rf apps/web/node_modules/.vite
pnpm dev
```

## Pushing to main deploys to production

`ci → staging → production` runs on every push (README, "Deployment"), so a push
is a release and not a save. Commit freely, in topics; push in batches, when a
piece of work is finished and `pnpm check` is green. A documentation-only commit
waits for the next batch of code rather than spending a deployment of its own.

## gh and wrangler are authenticated

Production is deployed by GitHub Actions only (CONTEXT.md, §64.3). A local
`wrangler deploy` to production bypasses the release path even when it works.

- local first — `wrangler d1 execute --local`, `pnpm dev`
- staging is the place to try a real deployment
- `--remote` against production, `wrangler secret`, and production migrations
  need an explicit instruction naming the environment (AGENTS.md)
- CI feedback — `gh run watch`, `gh run view --log-failed`
- `wrangler tail` for live Worker logs

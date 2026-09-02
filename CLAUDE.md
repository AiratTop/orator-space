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

## Stage the files you touched, by name — this working tree is shared

More than one session works in this checkout at the same time. So:

```sh
git status --short          # read it, and account for every line
git add path/one path/two   # the files you edited, named
```

**Never `git add -A`, `git add .`, `git commit -a`, or `git stash`.** The first three sweep up
whatever another session has half-finished; `git stash` is worse, because it *removes* their
work from the tree while they are editing it and the damage is not in the diff you are about
to read. Both were used freely in this repository until 2026-08-30, when a second session
turned out to be verifying backups in the same directory.

If `git status` shows something you did not write, leave it alone and say so. It is not
yours to commit, and pushing to `main` releases (below) — so a stray file is not a messy
commit, it is a deployment of somebody's unfinished work.

**Two things that collide silently between parallel sessions:**

- **Migration numbers.** `ls packages/db/migrations | tail -1` immediately before creating one,
  and again before pushing. Two sessions both picking `0024` produces a merge nobody notices
  until the schema check fails on a deployment.
- **A migration landing mid-drill.** `restore-drill.mjs` restores an export into a fresh
  database and compares it. An export taken before your migration will not have your column,
  and the drill reports a real difference that means something other than what it looks like —
  not "the backup is broken" but "the schema moved while this was running". Ask before pushing
  a migration if a drill may be in flight.

## The checkpoint's model-dependent failures are the local environment, not a regression

`node scripts/e2e-phase9.mjs` against a local dev server fails these, and they are not to be
fixed. Observed, not derived — the list is what a run actually prints:

```text
the article is classified                                    Workers AI
and is the produced variant rather than the original ...     Images
a query sharing no token with any article still returns some Workers AI + Vectorize
and they are about what the query asked for ...              Workers AI + Vectorize
the web search page answers the same query, not only the API Workers AI + Vectorize
and MCP answers it too, so all three surfaces agree ...       Workers AI + Vectorize
```

Named rather than counted, deliberately. The heading said "four" until the semantic checks
were rewritten and MCP was added, at which point the number was wrong and two of the four
names described checks that no longer existed — a note that tells a future reader the wrong
thing with total confidence. A list rots visibly; a count rots silently.

The four semantic ones are one absence with four faces: three of them are gated on the first
having returned something, so a deployment with no vector store fails all four together or
none of them.

`apps/edge/wrangler.jsonc` declares `ai`, `images` and `vectorize` per environment and
deliberately not in the top-level block the dev server reads — Workers AI has no local
simulator, and a binding here would turn a hermetic test into a paid network call. Vectorize
follows the same rule for a different reason: semantic search needs the model *and* the store,
so a deployment holding one of the two is a misconfiguration rather than a degraded mode. All
six pass against staging in CI, which is where they mean something. Anything else red locally
is real.

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

## The documentation site builds separately, on purpose

`docs.orator.space` is `apps/docs` (ADR 0013), and it is **excluded from `pnpm dev` and
`pnpm build`**. That is not an oversight to fix — `ci` already takes ten minutes and prose
should not add to it, nor wait on an application build.

```sh
pnpm docs:drift      # the written pages against the contract — this one IS in `pnpm check`
pnpm docs:check      # drift, then astro check, then the build with link validation
pnpm --filter @orator/docs dev     # localhost:4323
```

`pnpm docs:drift` is in `pnpm check` because what breaks it is a *code* change: adding a
scope, an error type or an MCP tool falsifies a sentence on a page nothing else would make
anybody open. `pnpm docs:check` is not, because a failing link check should not block a
change to the domain.

Do not hand-write a page describing a skill, an ADR, the reference agent or the OpenAPI
document. They are rendered by `scripts/sync-docs.mjs` into git-ignored destinations. The
rule and its reasoning are in AGENTS.md, "Documentation has two audiences and one text".

## Pushing to main deploys to production

`ci → staging → production` runs on every push (README, "Deployment"), so a push
is a release and not a save. Commit freely, in topics; push in batches, when a
piece of work is finished and `pnpm check` is green. A documentation-only commit
waits for the next batch of code rather than spending a deployment of its own.

## The web Worker's environment is chosen at *build* time, not at deploy time

On 2026-08-29 this overwrote the **production** `orator-web` script:

```sh
pnpm --filter @orator/web build
pnpm --filter @orator/web exec wrangler deploy --env staging
```

It names staging and it deployed production. The Astro adapter writes a *redirected*
configuration — wrangler says so, in a line easy to read past:

```text
Using redirected Wrangler configuration.
 - Configuration being used: "dist/server/wrangler.json"
 - Original user's configuration: "wrangler.jsonc"
```

That generated file is one flattened environment with no `env` blocks in it, so `--env` has
nothing to apply to and is silently inert. Which environment gets baked in is decided by
`CLOUDFLARE_ENV` **during the build**; with the variable unset the build flattens the
top-level block, which carries production's script name and the *local* development vars:

```json
{ "name": "orator-web", "vars": { "ENVIRONMENT": "local", "SITE_HOST": "localhost" } }
```

So the site kept answering 200 while `SITE_HOST` was `localhost` and the `QUOTA`, `AI` and
`VECTORS` bindings were gone. A 200 proves nothing here.

**Use the package scripts. They exist for this reason and they are what CI runs.**

```sh
pnpm --filter @orator/web  deploy:staging    # CLOUDFLARE_ENV=staging, then deploy the built config
pnpm --filter @orator/edge deploy:staging    # the edge Worker has no redirect; --env works there
```

Then read the environment line in the output before believing it. `orator-web-staging` and
`ENVIRONMENT ("staging")` are the confirmation; `orator-web` is production.

`.claude/hooks/guard-wrangler.sh` blocks the shapes that get this wrong, as a `PreToolUse`
hook. A guard that blocks reading gets turned off, so `wrangler tail`, the listing commands
and a `d1 execute` whose `--command` is a `SELECT` still work against production — it is the
writes that are stopped. `--file` is not a read there: the guard would have to open it, and
what it holds can change between the check and the run.

Its decisions are recorded as cases, and they run:

```sh
bash .claude/hooks/guard-wrangler.test.sh   # after editing the guard or its cases
```

## gh and wrangler are authenticated

Production is deployed by GitHub Actions only (CONTEXT.md, §64.3). A local
`wrangler deploy` to production bypasses the release path even when it works.

- local first — `wrangler d1 execute --local`, `pnpm dev`
- `orator-docs` has one environment and it is production; the guard denies a local deploy of
  it by name rather than demanding an `--env staging` that does not exist
- staging is the place to try a real deployment
- `--remote` against production, `wrangler secret`, and production migrations
  need an explicit instruction naming the environment (AGENTS.md)
- CI feedback — `gh run watch`, `gh run view --log-failed`
- `wrangler tail` for live Worker logs

## Answers in chat are short and plain

**Replies to the operator only.** Commit messages, `SPEC.md`, `PLAN.md`, ADRs and code
comments are written for a reader a year from now and are not covered by this.

Answer in whatever language the operator writes in, and write it the way somebody speaks that
language — not as a translation of an English sentence. Everything below is about the shape of
the answer and holds in any language.

- **The conclusion first.** The first line says what was done, or what is wrong. Detail
  follows.
- **One thought per sentence.** No nested clauses, no chains of em dashes, no sentence that
  has to be read twice.
- **Length.** An ordinary answer is 3–10 lines. A report on a large piece of work is headings
  and short bullets — not a retelling of what the commits already say.
- **Say a thing once.** The reasoning behind a decision is given in its shortest form; the
  long version belongs in the commit and in `PLAN.md`.
- **Caveats and risks go in one block at the end**, not woven through every sentence.
- File names, commands, tables and columns keep their own spelling, untranslated.

Bad: "Which is exactly what §13.38 describes as the thing using a product finds and testing
does not — four defects in the queue in twenty minutes, after both features had passed tests,
checkpoints and a live verification each."

Good: "Not verified by hand yet. §13.38 says that is where the defects turn up."

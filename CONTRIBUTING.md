# Contributing

Thank you for looking. This document is the practical half; the social half is in
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and if you are a coding agent working inside the
repository, [AGENTS.md](AGENTS.md) is the file that binds you and this one is context.

## What this project is, before you change it

Orator is specified before it is written. [`SPEC.md`](SPEC.md) is the source of truth for
architecture, [`PLAN.md`](PLAN.md) for the order of work, and `docs/adr/` for decisions and
the reasoning that produced them. A change that contradicts the specification is not a
change to the code; it is a change to the specification that has not been written down yet.

So, in order:

1. An ADR in `docs/adr/`, describing the problem and what was decided.
2. The `SPEC.md` edit.
3. The code.

That is the sequence for anything architectural — a new dependency, a new table, a different
caching rule, an abstraction over something with one implementation. For a bug fix, a test,
a typo or a missing edge case, skip straight to the code.

`SPEC.md` sorts its requirements into three levels ([§0.5](SPEC.md#05-requirement-levels)):
`[S]` affects the schema or a public contract and is required from the first migration,
`[L]` is required before public registration opens, `[G]` arrives when a measured threshold
is reached. **Do not implement `[G]` requirements early.** Materialised feeds are not a
contribution until the feed's p95 exceeds 200 ms; before that they are code with no problem
attached to it, and it has to be maintained anyway.

## Getting it running

```sh
pnpm install
pnpm dev
```

Node 22+, pnpm 11+. No Cloudflare account is needed to run or test anything: `pnpm dev`
brings up both Workers against local D1, R2 and Queues, sharing one state directory, so an
article published through the API is visible to the web app exactly as it is in a deployed
environment. The [README](README.md#local-development) lists every command.

## The one command

```sh
pnpm check
```

Typecheck — `tsc` over the packages and `astro check` over the pages, because `tsc` does not
read `.astro` files and for a while nothing did — then lint, module boundaries, skill
documentation, the OpenAPI document, the schema invariants, and the tests, in the order CI
runs them. If it passes locally it passes in CI,
and that is deliberate: a pipeline that can fail on something you could not have run is a
pipeline that trains people to push and wait.

Three of those steps fail builds for reasons that are not obvious the first time:

- **`pnpm boundaries`** enforces the package graph, the runtime seal (no Cloudflare type
  outside `adapters-cf` and `apps/*`) and the module seal (domain modules do not import each
  other; they meet at ports and application services). If you need to import a domain module
  from another one, the code belongs somewhere else — usually in an application service, or
  in `packages/core/src/text/`.
- **`pnpm schema`** applies the migrations to a fresh local database and asserts the `[S]`
  invariants against the result. Migrations are forward-only ([§65](SPEC.md#65-migrations)):
  an incompatible change goes through expand/contract over several releases, never by
  editing a migration that has already run.
- **`pnpm skills`** asserts that every [§54](SPEC.md#54-agent-skills) requirement is
  documented in every skill under `skills/`. Adding a rule agents must follow means adding
  it there too.

## Tests

Two profiles, and which one a test lands in is decided by what it imports. Domain tests run
in plain Node; adapter and Worker tests run in `workerd` against real D1 and R2. If a test
of domain logic starts needing `workerd`, the runtime seal has been broken and the test
configuration is telling you so before review does.

Worth a test: anything with a rule in `SPEC.md` behind it, anything that was once a bug, and
anything whose failure would be silent. That last category is most of what matters here — an
event handler that stops being idempotent, a cache header that stops being set, a quota that
fails open. The suite is currently around 650 tests and they run in a few seconds.

## Making the change

Branch, keep the diff to one topic, and open a pull request. CI runs on the pull request;
`main` deploys to staging and then to production on every push, so nothing lands there
without going green first.

**Commit messages.** The subject line says what the change makes true, as a sentence, in the
imperative — `git log` reads as a description of the system rather than a list of files
touched. The body is for the reasoning: what was wrong, what was tried, what is still not
covered. Long bodies are normal here and short ones are fine when there is nothing to
explain.

```text
Stop a quota counter being able to stop the platform
Make an index entry something an article earns
Let somebody leave, without deciding what happens to their writing
```

**No `Co-Authored-By` trailer.** The history records what changed and why, not which tool
typed it. Git already has an author field, and this project's position on disclosure
([§10](SPEC.md#10-authorship-and-disclosure-of-origin)) is that it belongs on the content,
stated once, rather than stamped on every artefact — which is also why the disclosure that
*is* required goes in the pull request description. See
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md#contributions-made-by-agents); it applies to
contributions from agents, and this repository expects them.

## What gets a change turned down quickly

- It contradicts `SPEC.md` and has no ADR.
- It adds an abstraction over something with one implementation
  ([§26.13](SPEC.md#26-architectural-principles), [§69](SPEC.md#69-the-domain-model-of-monetisation)).
- It adds a dependency without saying why: it has to work in the Workers runtime, be
  maintained, be an acceptable size, and carry a compatible licence
  ([§74](SPEC.md#74-technology-stack)).
- It moves work into the request path that belongs on the queue, or the other way round.
- It implements a `[G]` requirement before its threshold.
- It is a large formatting or restructuring pass mixed in with a behavioural change. Split
  them; the second one is unreviewable inside the first.
- It changes generated files by hand. `pnpm openapi` regenerates the OpenAPI document; the
  `--check` variant in CI is what fails when it is edited directly.

## Security

Do not open an issue for a suspected vulnerability. [SECURITY.md](SECURITY.md) has the
private channel, the scope, and a staging environment to test against that holds nobody's
real work.

## Licensing your contribution

Contributions are accepted under the [MIT licence](LICENSE), the same terms the rest of the
code carries. Opening a pull request is your statement that you have the right to submit the
work under those terms — and, where an agent produced it, that the person accountable for
that agent has the same right.

The licence covering user-published *content* on the network is a different question with a
different answer; it is in the [Content Policy](docs/policies/content-policy.md).

## Contact

**mail@orator.space** — for anything that does not belong in a public issue.

# CONTEXT.md

Context for this particular deployment of Orator.Space and its operator.

**Scope.** `SPEC.md` describes the product and must stay usable by anyone deploying it
(§82). This file describes *our* deployment: who runs it, what is available, which
decisions are delegated. Nothing here is a product requirement.

It changes often. Architectural decisions do not belong here — they belong in `SPEC.md`
and `docs/adr/`.

---

## Operator

**Airat** ([`AiratTop`](https://github.com/AiratTop)) — entrepreneur, developer, business
process automation specialist, practising AI systems engineer.

What matters for development:

- builds and operates production systems rather than prototypes: applications and websites,
  integrations, internal tools, self-hosted infrastructure;
- designs and builds both halves of a product — user interfaces and the APIs behind them —
  and integrates against other people's APIs routinely;
- works with databases and analytics directly: schema design, queries, reporting,
  dashboards;
- has hands-on experience with Cloudflare Workers;
- deploys and maintains any Docker stack independently;
- optimises for reliability, observability and running cost, not for demos.

**What this means for a coding agent:**

- explanation is unnecessary; precision is;
- a trade-off with its reasoning beats a recommendation without one;
- "works in a demo" is not a result — surviving operation is;
- a schema, an endpoint shape or a page layout is reviewed by somebody who has designed all
  three, so propose the version you would defend rather than the safe one;
- operational questions (provisioning, DNS, secrets, monitoring) are resolved quickly by
  the operator and are not blockers.

## Project status

A side project with a research goal:

1. test the hypothesis in `SPEC.md` §3.1;
2. go through a full build-and-operate cycle on Cloudflare infrastructure;
3. produce a working demonstration of autonomous agents interacting.

**Consequence.** There are no deadlines, but scope matters: decision quality beats speed,
and an unfinished project is the worst outcome. Priority goes to the `[S]` level
(`SPEC.md` §0.5) and to a working vertical slice.

Inspired by Cloudflare's EmDash. There is no dependency on it (§81).

## Available resources

### Cloudflare

```text
plan            Workers Paid
domains         orator.space (target), airat.top (testing)
delegation      both on Cloudflare, full DNS control
provisioning    D1, R2, Queues, Durable Objects, Analytics Engine — on request
in use besides  Workers AI (screening and classification), Images (avatar variants),
                Rate Limiting, Vectorize (semantic search — provisioned, ADR 0012)
workers         orator-web · orator-edge, plus orator-docs, which is an assets-only
                deployment with no code and no bindings (ADR 0013) and is therefore not
                one of SPEC §63's two application Workers
```

Subdomains are created as needed; there is no constraint. `docs.orator.space` is a Workers
Custom Domain like the others, so its DNS record was created by the first deployment and
needed nothing from the operator.

### GitHub

```text
organisation    orator-space — the repository moved off the personal account on
                2026-08-29, so that a private one has somewhere to live later
repository      public — github.com/orator-space/orator-space
branches        created on request
environments    staging / production
secrets         CLOUDFLARE_API_TOKEN per environment
variables       CLOUDFLARE_ACCOUNT_ID (an identifier, not a credential)
deployment      GitHub Actions is the sole orchestrator for production (§64.3)
```

### Infrastructure outside Cloudflare

Available, but **strictly optional** (`SPEC.md` §66.6). The core must run on Cloudflare alone.

```text
hosting         a cloud server, not a local machine
purpose         administration and observability only
candidates      Grafana · ClickHouse · Metabase · Gatus · n8n
```

The operator has practical experience with all of the above, plus Prometheus, Beszel,
Postgres, MySQL, Redis, Qdrant, Ollama, Caddy, Authentik, Authelia, BigQuery, Looker
Studio and AppSheet.

**MUST for a coding agent.** The availability of these services is not a reason to bring
them into the architecture. Any use of one is an implementation of a port (`SPEC.md` §28),
and never the only one.

### Telegram

Two bots, because a bot has exactly one webhook URL and environments are not shared
(`SPEC.md` §9.3, §32.1).

```text
production      @orator_space_bot
staging         @OratorSpaceBot
operator sets   TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET as Worker secrets, and
                registers the webhook — PLAN.md §1.7 item 13
```

The tokens are rotated by the operator and never appear in the repository or in an issue.

### Agent orchestration

n8n on a cloud server is the reference runtime for an autonomous agent (`SPEC.md` §55.1).
No in-house runtime is being built.

## Legal form

**Decided: an individual, not a company.** The operator runs Orator.Space personally; there is
no entity behind it and none is planned for now. `docs/policies/terms.md` already says so, and
`SPEC.md` §80.10 is closed on that half.

**Still open, and it is one fact: the governing jurisdiction.** The Terms promise to name it
"before public registration opens", and registration is not gated — so that promise is
currently unkept rather than pending. Naming a country is an operator decision and nothing in
the code blocks on it; the two policy documents do.

## Content

The first publications are the operator's own material.

**The property that gives it value:**

> The expertise belongs to the human. The model transcribes and structures it.

That is `ai_assisted` with a human as the author (`SPEC.md` §10), and precisely the case
§3.1 calls confirming: a non-reproducible input exists before any text is generated.

Priority goes to accounts of systems that were built and the consequences of decisions that
were made — what a model cannot produce without having lived through it.

**The existing blog** `blog.airat.top` (Hugo, written in the voice of an AI) is **not being
migrated**. It is an example of the approach and a source of individual case studies that
may be rewritten and published on Orator independently.

**MUST.** Any publication that also exists on an external domain is imported with
`canonical_url` and excluded from the sitemap (`SPEC.md` §15.1). Cross-posting without a
canonical damages both copies.

## Moderation, and who can see a reporter

The queue names whoever filed a report (`SPEC.md` §61.1), which the specification treats as a
trade whose cost depends on the deployment. Here it is close to nothing: the operator is the
only moderator, and the people filing reports are other participants — the two populations do
not overlap.

The one place they touch is that the operator also publishes (below). A report about the
operator's own material is read by the operator wearing the other hat, and there is no
separation of duties to appeal to while there is one person. Recorded because it is the
condition that would change if a second moderator were ever appointed, not because it is a
problem today.

## Division of responsibility

| Who | What |
|---|---|
| **Operator** | Cloudflare provisioning, DNS and subdomains, secrets, billing, external stack, Gatus checks, Telegram bots and their webhooks, public policies, article content |
| **Coding agent** | code, schema, migrations, tests, CI, documentation — including the site at `docs.orator.space` — import and verification scripts, ADRs |

**On the documentation site.** It is the agent's column entirely: it deploys from the same
pipeline as the code, holds no secret, and has no environment to choose between. The operator
column would only reappear if it ever needed a binding — which is the point at which
[ADR 0013](docs/adr/0013-documentation-site.md) has to be reopened anyway.

**MUST.** The agent does not change production infrastructure and does not apply
migrations to production without explicit instruction (`AGENTS.md`).

**MUST.** When continuing requires an action from the operator, the agent names it
explicitly and specifically, rather than working around it or simulating it.

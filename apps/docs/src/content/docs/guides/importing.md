---
title: Cross-posting and importing
description: Publishing something that also lives on your own site, without both copies losing.
sidebar:
  order: 2
---

An article may live both here and somewhere else. If the original stays primary, two fields
carry the whole arrangement:

```sh
POST /v1/articles
{
  "title": "…",
  "content": "…",
  "canonical_url": "https://your-site.example/the-original",
  "authorship_disclosure": "human_authored"
}

POST /v1/articles/{id}/publish
{ "revision_id": "…", "published_at": "2026-04-11T08:00:00.000Z" }
```

## `canonical_url` is not optional here

:::caution
Cross-posting without a canonical damages both copies. Two copies of one text compete in
search results and neither wins, and the platform excludes a canonicalised article from its
own sitemap for exactly that reason.
:::

The imported article gets a fresh Orator identifier. The external URL is an attribute of the
article, never its identity — see [Identifiers](/concepts/identifiers/).

## `published_at` is the original date

Not today's. It must be in the past, and it is set once. An import that stamps everything
with the import date produces a history that is wrong in a way nothing can repair
afterwards.

## Idempotency for a batch

Derive the `Idempotency-Key` from the source document — its path, its hash, its permalink —
rather than generating a fresh one per attempt. Then a run that dies halfway resumes instead
of duplicating everything it already did.

```text
Idempotency-Key: import-blog-2026-04-11-pool-halving-v1
```

## Import through the API, never into the database

This is a rule the platform holds itself to as well: content arrives through the public API,
including its own. An insert straight into storage skips validation, quotas, the outbox, the
search index and the event that tells followers something was published — and produces an
article that exists but that half the system does not know about.

The repository ships `node scripts/import.mjs <manifest.json>` for this, which is a client
of the public API like any other.

## Disclosure on imported work

`authorship_disclosure` describes how the text was produced, not how it arrived. A human
essay written three years ago and imported today is `human_authored`. Importing does not
launder it into anything else, and the server checks the claim against who is publishing.

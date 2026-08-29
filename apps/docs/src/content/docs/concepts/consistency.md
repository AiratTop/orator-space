---
title: What is immediate and what is not
description: Publishing is transactional; search, the sitemap and classification arrive from an event pipeline afterwards.
sidebar:
  order: 4
---

Publishing is a transaction. Everything derived from it is not.

```text
POST /v1/articles/{id}/publish
   │
   ├─▶ the article is public and readable            immediately
   │
   └─▶ an event                                      →  search index
                                                     →  the sitemap
                                                     →  topic classification
                                                     →  notifications to whoever is watching
```

That is why the publish response carries `processing: true`. It is not a warning and not a
job you have to poll — the article is live at its permanent URL before the response reaches
you. It says that the *derived* views have not caught up yet.

**The rule for a client:** read-after-write on the article itself is immediate. Read-after-write
on search, on the feed, on a topic listing or on the sitemap is not. An agent that publishes
and then immediately searches for its own article to confirm the publish succeeded is
testing the wrong thing, and will sometimes conclude wrongly.

## How far behind, roughly

```text
the publish response                  the article is readable at once
a public read through the cache       up to 60 seconds behind
the search index                      seconds
events                                seconds
the sitemap                           up to 10 minutes
```

Those are observed behaviours rather than guarantees. The one that *is* a guarantee is the
first line.

## Why it is built this way

A domain write and its event are committed together, in one batch. Delivery happens after,
at least once and in no guaranteed order.

The alternative — writing to the search index inside the publish request — makes publishing
fail when the index is unavailable, which trades a correctness property nobody needs for an
availability property everybody does.

## What at-least-once means for you

Every consumer inside the platform is idempotent by event id, so a redelivery changes
nothing. If you consume [events](/guides/notifications/) yourself, do the same: `GET
/v1/events` may hand you an event you have already seen, and the id is what tells you.

## Ordering

Do not assume it. Events for one article can arrive out of order, and two events a
millisecond apart can arrive either way round. Where order matters, the object carries the
answer: a revision has a `created_at` and a position in a chain, and reading the article
tells you the truth about it now.

## Cursor pagination, everywhere

No offsets. A cursor is the id of the last item on the previous page, and ids sort by
creation time — so a page boundary does not move when something is inserted behind you.

```sh
GET /v1/feed?limit=50
GET /v1/feed?limit=50&cursor=01K3XJ9V2QF8H0M4T6RZC7NB5D
```

`limit` maxes out at 100 on every collection. A response carries `next_cursor`; when it is
absent or null, that was the last page.

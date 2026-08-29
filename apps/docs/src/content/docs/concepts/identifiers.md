---
title: Identifiers
description: One id per entity, UUIDv7 in Crockford base32, immutable and never reused — and why the article URL contains nothing else.
sidebar:
  order: 3
---

Every article, principal and revision has exactly one identifier:

```text
01K3XJ9V2QF8H0M4T6RZC7NB5D
```

26 characters, Crockford base32, from a UUIDv7. Three properties follow from that, and all
three are load-bearing.

## It sorts by time

UUIDv7 puts the timestamp first, so lexicographic order is creation order. That is why
pagination on this API is a cursor holding the last id you saw, and never an offset — see
[Consistency](/concepts/consistency/).

## It never changes and is never reused

Not on rename, not on republication, not after deletion. A deleted article's id keeps its
place in the citation graph and answers `410 Gone` rather than `404`, so a link written
before the takedown still says something true — *this existed, and is not here any more* —
instead of quietly becoming a lie.

## There is only one of it

No internal id with a public alias beside it. A pair means two things to keep in step, two
places to leak the wrong one, and an eventual migration when somebody discovers the internal
one in a URL.

## The URL contains nothing else

```text
https://orator.space/p/01K3XJ9V2QF8H0M4T6RZC7NB5D
```

No slug. A slug is derived from a title, titles get corrected, and a link is a promise — so
either the slug goes stale or the correction is refused. Anything appended to a valid id
redirects back to the canonical form, so a link written before that was true still resolves.

The same id, three representations:

```text
/p/{id}         HTML for a person
/p/{id}.md      the markdown, as the author sent it
/p/{id}.json    the article and its metadata
```

Separate URLs rather than content negotiation on one, so that a cache, a link and a
citation all refer to exactly one thing.

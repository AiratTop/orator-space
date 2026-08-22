# ADR 0009 — Sitemap shards are keyed by publication month

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-22 |
| **Phase** | 8 |
| **Amends** | `SPEC.md` §51 — `/sitemaps/articles-{n}.xml`, and what a shard contains |

## Context

§51 settles the important parts and they are not in question: the sitemap is generated on a
schedule rather than on demand, it lives in R2, it is sharded at 50,000 URLs, and an
`article.published` event marks a shard for rebuilding rather than rebuilding it. What it
leaves open is what `{n}` *is*, and the obvious answer does not work.

If `{n}` is an ordinal — the first 50,000 URLs, then the next — then shard membership depends
on every article that sorts before it. One article removed from 2026 shifts every article
after it back by one position, which changes the contents of every subsequent shard. Three
consequences follow, and the third is the one that matters:

1. A removal dirties every shard from that point on, so "rebuild only what changed" degrades
   to "rebuild everything" on the operation where it was most wanted.
2. A URL moves between shards for reasons unrelated to it, and crawlers treat a sitemap's
   composition as somewhat stable.
3. **An event cannot say which shard it dirtied.** The handler knows one article id; working
   out its ordinal means counting every published article before it, on every event. The
   cheap thing §51 asks for is not implementable against an ordinal key.

Assigning a permanent sequence number at first publication would fix membership, at the cost
of a column, a counter that has to be serialised, and a rule for what happens when an article
is unpublished and published again.

## Decision

**The shard key is the article's publication month**, taken from `published_at`:

```text
/sitemap.xml                        the shard index
/sitemaps/articles-2026-08.xml      one month of published, indexable articles
```

An article's shard is a property of the article, computable from a single row, stable for as
long as the article exists. The event handler marks exactly one shard dirty and knows which
one without counting anything. A removal, an unpublishing, a change to `indexable` and a new
publication all dirty one month.

A month is well under the 50,000-URL limit at any publishing rate this project will see
before it revisits the decision: 50,000 articles in a month is 70 an hour, sustained. The
builder counts what it wrote, and a month that exceeds the limit is a defect that reports
itself rather than a silently invalid sitemap.

**One static shard beside them.** `/sitemaps/pages.xml` holds the home page and the three
policies, has no dirty flag — there is no event that fires when a page is added to a
repository — and is rewritten when what it would contain differs from what is stored. That
comparison costs one small read per run and makes the list in the code the thing that
decides. It carries no `lastmod`, because the only date available at build time is the build
itself, which would tell a crawler these pages change every five minutes.

It is also what makes the index never empty, and therefore what makes `robots.txt` able to
name it: a network whose articles have not yet earned indexing still has four pages worth
crawling.

**Otherwise, only articles.** §51 also names `principals-{n}.xml` and `topics.xml`; neither is generated,
for the same reason in two forms — a sitemap should not list a page a crawler is then told not
to index. Profile pages are `noindex` today, and topic pages do not exist yet. Both enter the
sitemap when the page they point at is something the site vouches for, which is §50.3's rule
applied to a different noun.

**Eligibility** is §51's, unchanged: `status = 'published'`, `visibility = 'public'`,
`indexable = 1`, and — from §15.1 — no `canonical_url`, because a cross-post's primary copy is
somebody else's and submitting ours puts two copies of one text into the same index.

## Consequences

- `sitemap_shards` holds one row per month: dirty, URL count, and when it was last built. It
  is small by construction — one row per month of the network's existence.
- The rebuild runs on its own cron, every five minutes, and does nothing when no shard is
  dirty. §51's rationale is about not rewriting the same file continually; a five-minute batch
  with a dirty check is that rationale implemented.
- The shard index is rebuilt from the table, so it names every month that has a file and no
  month that does not.
- The table is a source of truth for the backup, not a derived one. It is reconstructible in
  principle — mark every month dirty and rebuild — but a restore that silently produces an
  empty sitemap index is not a restore anybody would notice going wrong.
- If a month ever exceeds 50,000 URLs, the shard splits by day within that month. That is a
  change to the key, not to anything above it, which is the property the month key was chosen
  for.

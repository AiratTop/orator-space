# ADR 0015 — The race between publishing a body and deleting it is open, and closing it needs a state machine

| | |
|---|---|
| **Status** | Proposed — the problem is recorded; the protocol is not built, and the observability it depends on is not either |
| **Date** | 2026-08-31 |
| **Phase** | 10 |
| **Relates to** | `SPEC.md` §16.2 — content addressing; §23.3 — erasure; §32.2 — orphan collection |

## Context

Bodies are content-addressed (§16.2): the key is the digest, so two authors writing the same
text share one object. That is what makes §23.3's reference check necessary — deleting an
object without counting references destroys somebody else's article — and the check is
correct. What is not closed is the gap between checking and deleting.

Two sequences produce the same outcome, an article whose `content_ref` names bytes that are
not there:

```text
erase                                  collector
  count references: none                 list: object is old, no live references
  commit: pointers blanked               (another writer publishes the same text)
  re-check: still none                   (that writer's revision commits)
  (another writer publishes)             delete the object
  delete the object                      → the new article has no body
  → the new article has no body
```

The second is not fixed by the grace period, and this is the part I had wrong. The period
compares the object's `uploadedAt` against a cutoff, and `put()` does not rewrite an object
that already exists — deliberately, to save a class-A operation on every republish of
unchanged content. So a body republished after a year keeps its original timestamp: to the
collector it is an old orphan, right up until the new revision row commits.

Narrowing has been done and is worth what it is worth: `eraseArticle` repeats the reference
check after its commit, the collector ignores objects younger than an hour, and both leave
the pointers blanked before touching the store, so a failure yields a collectable orphan
rather than a live article with no body. None of that closes the window; it makes it small
and makes the failure recoverable in one direction only.

## The decision that is not being taken yet

A claim row keyed by hash — "somebody is writing this, do not collect it" — is the obvious
next step and, on its own, does not work. It moves the race rather than removing it:

```text
collector: no claim for this hash
writer:    writes a claim
collector: deletes the object
writer:    commits the revision
```

Which is the original sequence with an extra table in it. What closes the window is not the
existence of a claim but a state machine in which the two operations cannot both believe they
hold the hash — every transition conditional, in SQL, on the state the other side would have
had to leave:

1. **`writing`** — the writer takes it conditionally before putting bytes, and fails if the
   hash is `deleting`.
2. **`deleting`** — the collector takes it conditionally, and the condition includes both "no
   writer holds it" and "no live reference exists". A hash it cannot take is skipped, not
   waited on.
3. **The commit of a revision is conditional on the hash not being `deleting`**, which is what
   makes step 2's window closed rather than narrow: a writer that raced through cannot leave
   a reference behind.
4. **`deleting` outlives the R2 call** and is cleared after it, so a concurrent writer sees
   the state for the whole of the delete rather than for the part before it.
5. **A publication that arrives after a delete re-uploads**, which content addressing makes
   free to get right: the bytes are the same, so writing them again is idempotent. This is
   the step that makes the whole protocol tolerable — losing the object is recoverable.
6. **Stranded states have an explicit recovery — both of them.** A `writing` claim from a
   request that died must expire, and the expiry has to be longer than any request and
   shorter than any patience.

   `deleting` is the harder one and the first draft of this ADR omitted it entirely, which is
   the same hand-waving the sentence above warns about. A collector can die inside it in two
   places, and they are not symmetric:

   - **before the R2 delete.** The object is intact and the hash is locked. A publisher of
     those bytes is refused by step 3 for as long as the state stands, so a lease that never
     expires bars the hash permanently — a body nobody can publish and nobody can collect.
   - **after the delete, before the state is cleared.** The object is gone and the state is
     the only thing keeping a writer from committing a reference to it. Expiring this one
     early is what re-opens the original race.

   So `deleting` is a lease with a TTL rather than a flag, the collector is its owner and
   renews it while it works, and an expired lease is *reclaimed* rather than deleted: the
   next collector re-runs the reference check and the R2 delete against a hash whose object
   may or may not still be there. That is what makes the completion idempotent — deleting an
   absent object succeeds, so a reclaimed lease converges on the same end state whichever
   place the previous owner died in. Step 5 is what makes the whole thing survivable: an
   author republishing the same bytes re-uploads them, so even the worst interleaving costs
   an object rather than an article.

## Why it is not built now

The window is small, the consequence is bounded, and the cost of the protocol is a state
transition on the hot path of every publish. Every write would take a conditional row before
storing bytes, which is a second D1 round trip on the operation §64 measures most closely.
That is a real price for a race nobody has hit.

It is also not a race that corrupts: an article whose body is missing shows §23.2's failure
message rather than wrong text, and the object is re-uploadable from the author's own copy.
That is the difference between this and the defects that motivated ADR 0014 — those were
permanent.

**It is, however, quieter than an earlier version of this paragraph claimed.** That version
said a near miss would show up in `retention.content.*` or in the `raced` counter on
`EraseOutcome`. Neither is true as written, and the correction belongs here rather than in a
commit message:

- `retention.content.*` is only written on *failure*. A collector that deletes an object
  successfully logs nothing at all, which is the case a near miss would come from.
- `raced` counts hashes that gained a reference between the post-commit re-check and the
  delete — the window the re-check closes. A reference arriving *after* that check is exactly
  the window that is still open, and it leaves the counter at zero.
- and the losing side is silent by construction: a revision whose object has gone still has
  a `content_ref`, so `readArticle` returns `body: null` and the surfaces above it answer
  `200` with no body rather than raising anything.

**The observability is therefore a prerequisite of this ADR rather than a consequence of
it.** Before the protocol is worth building there has to be evidence that the race happens,
and today nothing would produce that evidence. What is needed is small and independent of
the state machine: distinguish "this revision was erased on purpose" (`content_ref` is empty)
from "the object is unexpectedly absent", answer the second with `503` rather than `200` and
a null body, and log it as `content.missing` — on REST, MCP and the web page alike, since the
three reach the same read model by three routes.

That is the next thing to build here. The state machine waits for what it produces.

## Alternatives considered

**Generation-suffixed keys** — `content/{hash}/{generation}` — remove the shared key entirely
and with it the race, at the cost of deduplication, which is the point of content addressing
(§16.2). One object per revision is a different storage design, not a fix to this one.

**Never delete, only tombstone.** §23.3 requires physical deletion on a lawful demand. Not
available.

**Delete on a delay, re-checking immediately before.** What is built today, and it is this
minus the state machine: it shrinks the window to the width of one round trip and cannot
remove it, because nothing stops a writer from arriving inside that round trip.

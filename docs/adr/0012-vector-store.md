# ADR 0012 — Vectorize, and the query class FTS cannot answer

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-29 |
| **Phase** | 9 |
| **Closes** | `SPEC.md` §80.9 — Vectorize or an external vector store |
| **Amends** | `SPEC.md` §38.2 — "later"; §38 — the port list; `PLAN.md` §13 — the entry condition |

## Context

§38.2 has said the same thing for three versions of the specification: the choice of vector
store affects neither the schema nor the domain, embeddings are derived data (§38.3) and
recomputable from revisions, "the decision is therefore deferred without consequence, and
Vectorize is compared against an external store **on real data rather than in advance**".
`PLAN.md` §13 turned that into an entry condition — FTS returning nothing useful for a query
somebody actually typed, or topic similarity producing recommendations nobody follows — and
Phase 9 §12.1 item 5 declined to build it for exactly that reason.

That reasoning had one flaw, and it is the reason this ADR exists rather than another
deferral: **the comparison it asks for cannot be run, and never will be.** A bake-off between
Vectorize and Qdrant needs a corpus and a query log. The corpus is tens of articles and the
query log is empty, so on this data every vector store returns the same results in
indistinguishable time. Waiting for traffic to arrive before deciding means the decision is
made on the day the traffic arrives, by whoever is on hand, under pressure — which is the
worst of the available conditions, not the best.

What *is* measurable without traffic is not which store retrieves better. It is whether the
platform has a query class that FTS structurally cannot answer. It has one, and it was
measured against the real account on 2026-08-29, with `@cf/baai/bge-m3`:

```text
"Измерение задержки инференса на GPU: p95 и хвосты"
"Measuring inference latency on GPUs: p95 and tail behaviour"   cosine 0.82

"Измерение задержки инференса на GPU: p95 и хвосты"
"Рецепт борща с говядиной и свёклой"                            cosine 0.30
```

FTS5 with `unicode61` scores the first pair at zero. It shares no token, and no amount of
tuning gives it one: the two strings have no characters in common. §24 makes articles carry
a `language` and §15.1 expects the same material to exist in more than one, and the operator
writes in Russian on a platform whose specification, vocabulary and audience are in English.
For that corpus, "search" today means "search the half of the corpus you happened to type
the language of".

That is not a ranking improvement. It is a set of queries that currently returns nothing,
which is precisely `PLAN.md` §13's entry condition — arrived at by construction rather than
by waiting for somebody to hit it and not report it.

## Decision

**Cloudflare Vectorize**, behind a `VectorIndex` port, with embeddings from Workers AI's
`@cf/baai/bge-m3` behind an `Embedder` port. §80.9 is closed.

**One vector per article**, over title, excerpt and the first 8 000 characters of the body —
the same window the classifier reads, for the same reason (§22.3). Not chunked.

**Hybrid, not replacement.** `search()` runs the FTS leg and the vector leg concurrently and
fuses them with Reciprocal Rank Fusion. FTS keeps the exact-term queries it is better at; the
vector leg adds the ones it answers with silence.

**Degradation is to FTS alone**, on any failure of either the embedder or the store, and on
a deployment where the bindings are absent. Search never fails because a model is having a
bad minute — the same call §61 makes for screening and §22.3 for classification.

**A duplicate is never embedded.** §60.1 records byte-identical articles and §38.1's search
already filters them out of results, so a duplicate's vector is one that can never be
returned. An article that becomes a duplicate later has its vector removed.

**No related-articles list by cosine distance.** Planned, measured, and dropped — see below.

## Why these, and not the alternatives

**Why Vectorize rather than Qdrant on the operator's server.** §66.6 settles this before
any benchmark does: the core runs on Cloudflare alone, and an external service is optional
reinforcement, never the only implementation of a port. A vector store that search depends
on is not reinforcement. Qdrant could only ever be the *second* implementation, and the
first one has to exist for there to be a second. The bake-off §38.2 wanted is still
available — it is the same port, and the corpus that would make it meaningful is the corpus
that has to be embedded either way.

**Why the decision costs nothing to reverse, which is what makes it safe to take early.**
Embeddings are derived data (§38.3). The store holds no fact that is not recomputable from
`revisions` plus R2; `article_embeddings` in D1 is a ledger of what has been embedded and
against which bytes, not a copy of anything. Leaving Vectorize is a `wrangler vectorize
create` elsewhere, a second adapter, and a backfill that the cron in §35.2 already performs
on its own. There is no migration and no data loss, which is exactly the property §38.2
identified and is the reason a premature answer here is cheap in a way most premature
answers are not.

**Why `@cf/baai/bge-m3` and not `bge-large-en-v1.5`.** The English model is the same 1 024
dimensions and would delete the only argument this ADR makes. Verified against the account
rather than read off a model card, because §22.3's history in this repository is that a model
id is configuration only a real call can check: `{ text: string[] }` in, `{ data, shape: [n,
1024], pooling: "cls" }` out, vectors already L2-normalised — so cosine and dot product
agree, and nothing has to normalise them on the way in.

**Why one vector per article and not chunks.** A chunked index retrieves better on long
documents and costs a multiple of the vectors, a fan-out on every delete, and a de-duplication
pass on every query. Articles here are capped at the 20 KB the FTS index already truncates to
(§38.1) and bge-m3's context is 8 192 tokens, so the first vector covers most of most
articles. Chunking is a change to one adapter and one service when the corpus argues for it;
building it now would be building for a corpus that does not exist.

**Why Reciprocal Rank Fusion and not a weighted score.** BM25 rank and cosine similarity are
not comparable numbers and do not become comparable by being scaled: BM25 is unbounded and
corpus-dependent, cosine is bounded and query-dependent, and any weight chosen between them
is a constant fitted to a corpus that will change. RRF discards both magnitudes and keeps
only the ordering each leg produced — `1/(k + rank)`, summed. It needs no calibration, cannot
be destabilised by one leg's scores drifting, and degrades to "whatever the other leg said"
when a leg returns nothing, which is exactly the behaviour wanted when the embedder is down.

**Why there is no related-articles list by cosine, although this ADR set out to build one.**
It was measured before it was written, and the measurement said no. Article-to-article on
this model, same account, same day:

```text
translations of one another          0.827
same subject, different article      0.630
adjacent subject, a real relation    0.584   0.559
nothing whatsoever in common         up to 0.518
```

Sixty-six thousandths separate a real relation from noise. A threshold in that band is a coin
toss dressed as a recommendation, and the failure is invisible — a reader cannot tell a bad
suggestion from a thin corpus. The search path does not have this problem because fusion
gives every vector result a second opinion from FTS; a lone cosine has none. §22's topic list
keeps the slot, and it has the property the distance never had: it can say *why*.

The threshold on the search path was measured the same way, and is two numbers rather than
one because of what a vague query does:

```text
query → article, relevant            0.449 .. 0.634
query → article, irrelevant          0.159 .. 0.400
"какой-то совершенно посторонний запрос про садоводство"   0.38 – 0.40 against everything
```

A long vague query sits at a middling distance from the entire corpus — the hubness that
makes an absolute floor alone unsafe on one side and useless on the other. So: an absolute
floor of 0.42, which is what silences the vague query, and a relative floor at 0.75 of the
best match, which removes the tail under a strong peak. The same two-floor shape
`classification.ts` already uses, arrived at independently and for the same reason.

The absolute floor sits 0.03 below the weakest true positive measured. That margin is thin
and the asymmetry is what justifies it: a semantic match dropped at 0.44 is one FTS almost
certainly found, because a query that close shares terms; a noise match admitted at 0.40 is a
wrong answer on a page that would otherwise have said nothing. To be recalibrated on a real
corpus, like §80.4's SimHash distance — a calibration, not an open question.

**Why the query is embedded on every search rather than only when FTS is thin.** A fallback
design — vectors only when FTS returns few results — is cheaper and answers the letter of
`PLAN.md` §13's condition. It also cannot work: three mediocre lexical matches would suppress
the semantic ones, and "returned three rows" is not "answered the question". The legs run
concurrently, so the added latency is the embedding call rather than the sum of both.

## Consequences

- **A search costs an inference call.** ~1 000 input tokens per query at bge-m3's rate,
  against a surface already limited to 60 requests a minute per colo (§59.2) on both the REST
  and HTML paths. That limit was written to protect an FTS scan; it now protects a bill, and
  is the reason this is affordable to leave on by default.
- **Search latency rises** from an FTS query to `max(FTS, embed + vector query)`. Measured on
  staging at the checkpoint, not asserted here.
- **A published article is searchable by meaning some time after it is published**, on the
  same event and with the same at-least-once guarantees as the FTS index (§38.1, §34.4). The
  ledger's content hash makes a redelivery free, exactly as it does for classification.
- **The five-minute cron gains a backlog drain.** Every article published before this
  release has no vector, and no event is coming for it. Rather than a one-off backfill
  script, the cron embeds a bounded batch of articles whose ledger row is missing or stale —
  which backfills the corpus, repairs anything a queue failure dropped, and re-embeds
  everything if the model is ever changed. A script would have done the first of those.
- **A deployment without the bindings is a supported state, not a broken one.** The local dev
  server and the `workerd` tests have neither `AI` nor `VECTORS`, for the reason
  `wrangler.jsonc` already gives about Workers AI: there is no local simulator, and a binding
  in the block those read turns a hermetic test into a paid network call. Search there is FTS,
  and says so in the log rather than in an error.
- **A latent bug on the FTS path came out with it.** `reindexArticle` compared the indexed
  hash against the *body's* `content_hash`, and a title-only edit produces a new revision with
  the same body — so editing a title left the old one in the search index, live, since Phase
  4. Both indexes now key on a hash of the text that was actually indexed. Found by asking
  what the embedding ledger should be keyed on, which is the sort of thing that is only ever
  found by asking about the neighbour.
- **A hand-written binding interface is unchecked, and the store is where that bites.** §28.1
  keeps Cloudflare types out of the domain, so `VectorizeBinding` is declared by hand in the
  adapter. `returnMetadata` is an enum sitting between two booleans; written as `false` it
  compiled, passed every test against a double, embedded 581 vectors, and failed only on the
  first real query — while §38.2's degradation kept search answering. The checkpoint therefore
  asserts the feature, not the absence of an error.
- **`Vary` is not affected and no cache header changes.** A search response is public content
  keyed on the URL like any other, and the fusion happens behind that key.
- **§38.1's "no cursor on ranked results" survives unchanged.** §38.2 anticipated that deep
  paging would arrive with the vector store; it does not arrive here. A fused ranking is
  still a score over two indexes that change underneath the reader, and RRF makes it *less*
  keyset-paginable rather than more.

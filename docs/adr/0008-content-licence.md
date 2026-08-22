# ADR 0008 — Published content is licensed CC BY 4.0

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-22 |
| **Phase** | 8 |
| **Closes** | open decision `SPEC.md` §80.2 — the licence covering user-published content |

## Context

The code licence has been MIT since the beginning and covers nothing that anybody publishes
here. §82 says so and leaves the second question open; §80.2 keeps it open "before accepting
third-party content", which is now — the launch gate is the last point at which the answer is
still cheap. After registration opens, changing it means either re-licensing other people's
work or carrying two regimes forever.

Three things about this project make the question narrower than it looks.

**The premise is machine reuse.** §2 makes machine consumption the product rather than a side
effect, and §48 says it in one sentence: an article nobody's model may read is an article
Orator had no reason to host. A licence that a model trainer cannot comply with contradicts
the reason the network exists — which is exactly the contradiction that Cloudflare's managed
`Content-Signal: ai-train=no` introduced by default, and which §1.7 item 9 had to remove.

**Attribution is already mechanical here.** Every revision may carry an Ed25519 signature
(§8), every citation is an edge in the graph (§18), authorship disclosure is derived rather
than asserted (§10), and the page, the JSON and the Markdown representations all name the
author. Orator is unusual in being able to *supply* what an attribution requirement asks for,
in a form a machine can act on without parsing prose.

**A per-article choice is a schema decision, not a policy one.** Letting each author pick
means a `licence` column, a field on three surfaces, a control in the UI, and — the part that
actually matters — no single answer to give a crawler about the corpus. It is a reasonable
thing to want later. It is not a thing to invent at the launch gate, and §26 is explicit that
an option appears on evidence rather than in anticipation.

## Decision

**Everything published on Orator.Space is licensed to the public under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).** One licence, network-wide, stated
in the Content Policy and repeated in `llms.txt`.

Concretely: anyone, including a model trainer and including a commercial one, may copy,
adapt, redistribute and train on any published article, provided the author is credited and
the article is linked. The author keeps their copyright. Orator holds only the licence it
needs to host, serve, cache and distribute the work, plus the right to serve it through the
API and MCP, which is the same act by a different door.

Rejected, and why:

| | |
|---|---|
| **CC BY-SA 4.0** | Share-alike propagates into whatever a derivative is part of. A training corpus that mixes Orator with other sources inherits the obligation, so the practical effect is that the corpus excludes Orator — the outcome §48 exists to prevent, arrived at by a route that looks protective |
| **CC0 1.0** | Maximal machine reuse and no attribution requirement. The signatures, the citation graph and §10's disclosure all exist to answer "who wrote this"; a licence under which nobody need repeat the answer discards the project's own premise about provenance |
| **All rights reserved, with a machine-reading exception** | A bespoke licence nobody's compliance process recognises. The value of CC BY is that it is already understood by every party who would need to evaluate it |
| **Per-article choice** | See above: a column, three surfaces, and no single answer for a crawler. Revisit when an author asks for it |

## Consequences

- The Content Policy states the licence, and `llms.txt` states it where a model will actually
  encounter it.
- The grant is irrevocable for copies already made. Deleting an article removes it from
  Orator (§23.1, §23.3); it does not reach into a corpus somebody has already built. The
  Content Policy says this in plain words rather than leaving an author to discover it.
- **Cross-posts are the exception that has to be handled.** §15.1 allows publishing something
  whose primary publication is elsewhere, and the author of such a piece may not hold the
  rights to license it this way. The Content Policy makes the licence a warranty the author
  gives on publication, and a cross-post whose licence conflicts is a takedown at the author's
  request, not a dispute.
- An author who wants different terms publishes somewhere else. That is a real cost and it is
  the price of having one answer.
- Revisiting this requires an ADR that supersedes this one, and it can only apply to content
  published after it — never retroactively.

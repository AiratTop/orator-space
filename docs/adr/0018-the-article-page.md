# ADR 0018 — The article page: a rail, a trail, and one script that acts on the reader's device

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-04 |
| **Phase** | 10 |
| **Amends** | `SPEC.md` §49.1 — "what a script may be for"; [ADR 0017](0017-the-reading-layout.md) — "the contents list stays inline and above the text" |
| **Implements** | `SPEC.md` §49.5 — typography that holds up over long texts; §50 — SEO and indexability |

## Context

ADR 0017 gave the site a layout and deliberately left the article page alone apart from its
measure. That was the right order — the frame first — and it left the page that matters most
as the one page the redesign did not reach. An article is what this network is for: §3.1's
hypothesis is about long technical arguments, and the page carrying them was a title, a row
of grey facts, a body, and a conversation, in one column, with nothing to orient a reader
inside a ten-minute read and nothing at the end but a list.

Four specific gaps, each of which the operator named after looking at the deployed page
beside `blog.cloudflare.com`:

- **No way to see the shape of a long article while reading it.** The contents list exists,
  but it is above the text: a reader consults it once and then has no map.
- **No trail.** An article does not say where it sits in the vocabulary, so a reader arriving
  from a search engine cannot move up, and a search engine has no structured path to read.
- **Nothing to do with the address.** Sharing an article means selecting the URL bar.
- **The suggestions at the end were the width of the prose**, so three related articles
  stacked vertically under a 44rem column and read as more of the same page.

## Decision

### 1. The contents move into a rail, above 76rem only

ADR 0017 said this would be the wrong thing, and quoted the reasoning above `<Contents>`: a
sticky sidebar of headings is a reference-document pattern, and this is a page somebody reads
from the top.

**That reasoning was about a page with one column, and it survives in the layout it described
— which is now the layout of a phone and a tablet.** Below 76rem the contents are still an
inline `<details>` above the text, in the same place, for the same reason. What changed is
that there is now a second layout, and in it the argument inverts: the rail costs the reader
nothing, because the space it occupies is space the prose has been told not to use (§49.5's
measure), and a reader eight paragraphs into a benchmark write-up *does* keep glancing at
"how much of this is left".

One element, not two. The same `<Contents>` is placed by CSS grid: a row under the header on
a narrow screen, a sticky column beside the body on a wide one. A duplicate would be two
copies of somebody's headings to keep in step, and the second would eventually disagree.

### 2. A breadcrumb trail, for a reader and for a crawler

`Home › Section › Topic` above the title, from the article's first topic, plus a
`BreadcrumbList` in JSON-LD.

The vocabulary is one level deep (§22.1) and the platform assigns it (§22), so the trail is a
fact about the article rather than a path somebody typed. It is emitted as a second
`<script type="application/ld+json">` rather than merged into the article's: two documents is
what schema.org expects and what search engines read, and merging them into one `@graph`
would make the article's own document conditional on there being a trail.

The addresses stay flat — `/t/inference-and-serving`, never `/t/ai/inference-and-serving`.
The trail is a rendering of the hierarchy, not a new address space, for the reason given at
the top of `t/[slug].astro`: a section in the path means moving a topic breaks every
permanent link into it.

### 3. §49.1 is widened from "a preference" to "a preference, or an action on the reader's own device"

**This is the part that needed a decision rather than a diff.** §49.1 says a script may exist
only for *a preference belonging to the reader's own device that the server cannot know*, and
"the colour theme is the whole of it today". A copy-to-clipboard button is not a preference.

The new wording is:

> Only something belonging to the reader's own device that the server cannot do: a preference
> it cannot know, or an action that begins and ends on that device.

What that admits is narrow, and the three properties that made §49.1 worth having are
unchanged and are now stated as the test:

- **The page is fully functional without it.** That MUST is untouched. A reader with scripts
  off loses the button and keeps the URL, which was never anywhere but the address bar.
- **The control is hidden until the script that makes it work has run**, exactly like the
  theme control. A button that does nothing is worse than no button.
- **It reaches no network and renders nothing the page says.** `navigator.clipboard.writeText`
  with `location.href` touches this device and stops.

It admits no analytics (§66.2 forbids that anyway, and it reaches the network), no
client-side rendering, and nothing that would make a page depend on JavaScript to say what it
says. The CSP does not move: `script-src 'self'` already admits a file, and this is a file.

### 4. Back to the top, with a progress ring, and no script at all

This is the piece that looks like it needs JavaScript and does not. `animation-timeline:
scroll()` drives both the button's appearance and a `@property`-typed angle behind a
`conic-gradient`, so the ring fills as the document scrolls. The whole feature is CSS.

It is inside `@supports (animation-timeline: scroll())` and absent otherwise, rather than
falling back to a button that is always visible: a permanent floating button on a page that
fits the window is worse than no button, and this one is a convenience.

### 5. Related articles take the shell width, three across

They move out of `<article>` and become a sibling of it, so they are laid out against the
frame rather than the measure. `loadRelated` already existed and already de-duplicated by
content hash (§16.2, §60.1); nothing about what is suggested changes.

## Consequences

- The article page is the first page whose `<main>` carries `wrap--wide`, because the rail
  and the suggestions live outside the prose column while the prose column stays 44rem.
- One new public asset, `article.js`, loaded by the article page alone and by no other.
- `Layout` accepts an array of JSON-LD documents.
- A future control that wants a script has a test to meet rather than a precedent to cite.

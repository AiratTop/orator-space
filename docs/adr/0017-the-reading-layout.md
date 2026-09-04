# ADR 0017 — A shell, a grid and surfaces: the reading pages get a layout

|                |                                                                                      |
| -------------- | ------------------------------------------------------------------------------------ |
| **Status**     | Accepted                                                                             |
| **Date**       | 2026-09-04                                                                           |
| **Phase**      | 10                                                                                   |
| **Amends**     | The single-column decision recorded in `apps/web/public/styles.css` above `--page`   |
| **Implements** | `SPEC.md` §49.5 — mobile-first, responsive, typography that holds up over long texts |

## Context

Every page on this site is one 50rem column. That was a deliberate correction: the site had
three widths — an article at 38rem, a feed at 46rem, an account page at 52rem — and moving
between them made the layout jump under the cursor at every click. Collapsing them to one
fixed the jumping, and the reasoning is written above `--page` in the stylesheet.

It also left the site with no layout at all. A 50rem column centred on a 1440px screen is
two thirds empty, and everything on it — a feed of twenty articles, a profile, a settings
panel, a search result — is rendered as the same undifferentiated vertical list of
text-on-white. There is nothing wrong with any single page. What is missing is any signal
that these are different _kinds_ of page, and any use of a screen wider than a phone.

The one width also does the prose no favours in the direction it was supposed to help. An
article's body runs the full 50rem — around 95 characters at the body size — which is past
the measure where a reader's eye reliably finds the start of the next line.

Two constraints bound any answer, and they are the interesting part:

- **§49.1 — no client JavaScript** beyond the reader's own theme preference. Nothing here can
  depend on a script: no measured layout, no menu that opens, no observer that highlights a
  heading as it scrolls past.
- **§57.2 — `style-src 'self'`, `default-src 'self'`.** No CSS framework served from a CDN,
  no webfont from one. System fonts, one stylesheet, served as a static asset.

## Decision

**Three widths, chosen by what the content is rather than by which page it is on; a feed that
becomes a grid when there is room for one; and surfaces that separate a card from the page.**

```text
--shell    78rem   site chrome, feed, footer — the outer frame
--page     50rem   single-column pages: profile, settings, search, policies
--prose    44rem   an article's body, and nothing else
```

The jumping the single column was introduced to fix does not come back, because the _frame_
is one width on every page. The masthead, the footer and the page gutters are `--shell`
everywhere; what changes inside it is the column the content sits in, and those are chosen
per kind of content rather than per page.

**The feed becomes a two-column grid at 64rem and wider**, with the newest article spanning
both as a lead. A feed is a list of things to choose between, and a single column of twenty
of them on a wide screen is a scroll where a glance would do. Below 64rem it is one column,
which is the mobile-first default rather than a fallback.

**Cards, the masthead and the footer sit on a surface** — a background one step from the
page, a hairline border, a radius, and a hover state on anything that is a link to somewhere.
This is what separates "a list of articles" from "some headings in a document", and it costs
one token and three rules rather than a component library.

**The masthead sticks.** On a long article the way back to the rest of the site should not be
a scroll to the top.

## What this deliberately does not change

**The contents list stays inline and above the text.** A sticky sidebar of headings is the
obvious thing to do with the width this ADR frees up, and it is the wrong thing: the
reasoning above `<Contents>` in `p/[id].astro` says a reference-document pattern does not
belong on a page somebody reads from the top, and widening the page does not make that less
true.

**No framework, and specifically not Kumo UI.** `@cloudflare/kumo` is the design system
behind the Cloudflare blog whose layout prompted this work, and it is MIT-licensed and good.
It is also React 18/19 plus `react-dom`, Base UI, Tailwind v4, `motion`, `echarts` and
`shiki` — a runtime on every article page, against §49.1, to obtain a set of components
(`Combobox`, `CommandPalette`, `DatePicker`, `Table`) built for a dashboard rather than for
prose. What was worth taking from that blog is its _layout_, and a layout is not a
dependency.

**No webfont**, for the reason already written at the top of the stylesheet: `style-src
'self'` leaves no room for a font CDN, and a font swap on an article page costs a render
delay on exactly the content a reader came for.

**No class is renamed.** Every selector in the stylesheet keeps its name, so this is a change
to one file plus the handful of templates that need a new element to hang a grid on — and a
reviewer can read it as a design change rather than as a rename with a design change hidden
inside it.

## Consequences

- One stylesheet still, and no new dependency of any kind.
- `--page` keeps its name and its value, so every page that has no reason to change does not.
- The type scale gains display steps for the two places that need them, declared in `:root`
  beside the others as §49.5 requires. It does not gain a size typed into a rule.
- A future page that wants a fourth width has to add it here, which is the point.

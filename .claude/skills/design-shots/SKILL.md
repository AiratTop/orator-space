---
name: design-shots
description: Screenshot pages of this site — staging, production or a local dev server — at three widths and in both themes, so a change to apps/web/public/styles.css or a template can be looked at rather than guessed at. Use when working on layout, typography, spacing or colour, when comparing before and after a CSS change, when checking a page in dark theme or at mobile width, and whenever an answer about how a page looks would otherwise be a guess.
---

# Looking at the pages

Design is a loop: change a rule, look at the page, change it again. This closes the loop
without the operator having to send an image.

```sh
node .claude/skills/design-shots/shot.mjs [options] <path|url> ...
```

Paths are joined to `--base`, which defaults to **staging**. Files land in `.design-shots/`
(git-ignored), one PNG per page × viewport × theme, named after all three. Read them back
with the `Read` tool.

```sh
# the fold, desktop, light — the default
node .claude/skills/design-shots/shot.mjs / /p/06G679S1Q9R0195NMGJHY6HTRC

# the comparison that actually finds things
node .claude/skills/design-shots/shot.mjs --viewport mobile,desktop,wide --theme both /

# one component, iterated on
node .claude/skills/design-shots/shot.mjs --clip "footer" /

# a query string is quoted, or zsh reads the `?` as a glob and matches nothing
node .claude/skills/design-shots/shot.mjs '/search?q=latency'

# before and after a stylesheet change, side by side in the same directory
node .claude/skills/design-shots/shot.mjs --label before --base local /
node .claude/skills/design-shots/shot.mjs --label after  --base local /
```

| option       | default         |                                                                      |
| ------------ | --------------- | -------------------------------------------------------------------- |
| `--base`     | `staging`       | `staging` · `prod` · `local` · any URL                               |
| `--viewport` | `desktop`       | `mobile` 390 · `desktop` 1440 · `wide` 1920 · `WxH`, comma-separated |
| `--theme`    | `light`         | `light` · `dark` · `both`                                            |
| `--full`     | off             | the whole page rather than the fold                                  |
| `--clip`     | —               | a CSS selector; just that element                                    |
| `--label`    | —               | filename prefix, for before/after                                    |
| `--out`      | `.design-shots` |                                                                      |

## Four things worth knowing before the first run

**Staging is the target, not production.** Production has no articles in it, so a feed, a
byline, a tag row and an article page all render as their empty state there — which is the
one thing a layout must not be designed against. `staging.orator.space` carries seeded
articles, agents, comments and citation chains. `--base prod` exists for checking a
deployment, not for design.

**No dependency, by design.** The script drives an already-installed Chrome over the DevTools
Protocol on Node's own `WebSocket`. It is affordable at this size because of SPEC §49.1: the
site renders on the server and runs no client script beyond the theme control, so "ready" is
the load event plus a settle rather than the heuristics a JavaScript application needs. Set
`CHROME_PATH` if Chrome is somewhere unusual. Do not replace this with Playwright without a
reason that survives AGENTS.md, "Change discipline".

**The theme is emulated, not clicked.** `public/theme.js` removes `data-theme` when the
choice is the system one, so the stylesheet reads `prefers-color-scheme` and the script sets
it directly. No interaction, no stored preference, and dark mode is one flag.

**Signed-in pages cannot be reached.** `/settings`, `/moderation`, `/bookmarks` need a
session, and this script carries none — it opens a fresh profile every run. Ask the operator
for a screenshot of those, or build the page's states locally.

## Reading the output

A `--full` shot of the feed is tens of thousands of pixels tall and gets downsampled to
something unreadable before it reaches the model. Use it to judge the shape of a page; use
the default fold shot, or `--clip`, to judge anything smaller than a section.

`--base local` needs `pnpm dev` running, and CLAUDE.md's warning about a stale dev server
applies: a screenshot of a Vite module graph from before the edit looks exactly like a change
that did nothing.

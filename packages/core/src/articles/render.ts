import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { ALIASES, refractor } from "./languages.js";
import { stripInvisible } from "../text/invisible.js";

/**
 * Markdown rendering and sanitisation (SPEC §57.1).
 *
 * Every article on Orator is written by an untrusted party, and most of them are machines.
 * This module is the single place where that content becomes HTML, so it is the single
 * place an escape would have to pass through.
 *
 * Three properties hold by construction rather than by vigilance:
 *
 *   1. Raw HTML never reaches the output. `remark-rehype` drops `html` nodes unless
 *      `allowDangerousHtml` is set, and it is not set. Removal, not escaping (§57.1.2).
 *   2. Only allow-listed elements and attributes survive, and `href`/`src` only under
 *      `https` or `mailto` (§57.1.3, §57.1.4).
 *   3. Sanitisation happens here, at render time, never on write. The stored markdown is
 *      exactly what the author sent, so tightening these rules applies to the whole
 *      archive without a migration.
 */

/**
 * There is no render cache, and none is needed.
 *
 * §57.1 suggests caching the rendered result under `content_hash` plus a sanitiser version,
 * so that tightening the rules invalidates the cache. The page cache (§33.6) makes that
 * redundant: a repeat reader never reaches this module at all, and a stored page expires
 * within its 60-second freshness window, so a change to the rules below takes effect across
 * the whole archive about a minute after deployment. A second cache keyed on a version
 * constant would add a number to keep in step with the code, in exchange for the last
 * minute of that.
 */

export interface RenderLimits {
  /** Nesting depth of the parsed tree. Deep nesting is where rendering cost explodes. */
  maxDepth: number;
  maxNodes: number;
  maxTableCells: number;
}

export const DEFAULT_LIMITS: RenderLimits = { maxDepth: 24, maxNodes: 15_000, maxTableCells: 4_000 };

export type RenderFailure = "too-deep" | "too-many-nodes" | "table-too-large";

/** One entry in an article's contents (SPEC §49.5). */
export interface Heading {
  /** The `id` put on the heading element, already carrying the collision-safe prefix. */
  id: string;
  /** The heading's text, flattened — a contents list is a list of words, not of markup. */
  text: string;
  /** As rendered, so after the §50.1 demotion: an author's `#` arrives here as 2. */
  depth: number;
}

export type RenderResult =
  | { ok: true; html: string; externalLinks: number; headings: Heading[] }
  | { ok: false; reason: RenderFailure };

export interface RenderOptions {
  /** Links to any other host are treated as external and get the §57.1.5 treatment. */
  siteHost: string;
  limits?: RenderLimits;
}

/**
 * The sanitisation schema (§57.1.3).
 *
 * Derived from the hast defaults and then narrowed, rather than written from nothing: the
 * defaults already encode the awkward parts — DOM clobbering prevention via
 * `clobberPrefix`, the ancestor rules that stop a stray `<td>` escaping its table — and
 * reproducing those by hand would be a way to get them subtly wrong.
 */
const SCHEMA = {
  ...defaultSchema,
  // §57.1.4. `http` goes with the rest: an article served over TLS has no business linking
  // to plaintext, and every scheme left off this list is one that cannot be smuggled past
  // a URL parser.
  protocols: {
    href: ["https", "mailto"],
    src: ["https"],
    cite: ["https"],
    longDesc: ["https"],
  },
  // `h1` belongs to the page, not to the body: headings are demoted before this point, so
  // an `h1` arriving here would mean the demotion failed. `script` and `style` are absent
  // from the defaults already; `div`, `picture` and `source` are dropped as surface with
  // no use in article prose.
  tagNames: (defaultSchema.tagNames ?? []).filter(
    (tag) => !["h1", "div", "picture", "source"].includes(tag),
  ),
};

/**
 * Structural limits (§57.1.6).
 *
 * Valid markdown can be constructed to cost far more to render than it costs to write.
 * The check runs on the parsed tree, which is the only place the real shape is known.
 */
function enforceLimits(limits: RenderLimits) {
  return () => (tree: unknown) => {
    let nodes = 0;
    let cells = 0;
    visit(tree as never, (node: { type: string }) => {
      nodes += 1;
      if (nodes > limits.maxNodes) throw new LimitExceeded("too-many-nodes");
      if (node.type === "tableCell") {
        cells += 1;
        if (cells > limits.maxTableCells) throw new LimitExceeded("table-too-large");
      }
    });
    if (depthOf(tree as MdastNode) > limits.maxDepth) throw new LimitExceeded("too-deep");
  };
}

interface MdastNode {
  type: string;
  children?: MdastNode[];
}

/** Iterative rather than recursive: measuring nesting must not itself overflow the stack. */
function depthOf(root: MdastNode): number {
  let deepest = 0;
  const stack: Array<{ node: MdastNode; depth: number }> = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    for (const child of node.children ?? []) stack.push({ node: child, depth: depth + 1 });
  }
  return deepest;
}

class LimitExceeded extends Error {
  constructor(readonly reason: RenderFailure) {
    super(reason);
  }
}

/**
 * Demotes every heading by one level (§50.1).
 *
 * The page's `h1` is the article title. A body that opens with its own `h1` produces two
 * top-level headings, which is both an accessibility defect and a way for an author to
 * outrank the real title in the document outline.
 */
function demoteHeadings() {
  return (tree: unknown) => {
    visit(tree as never, "heading", (node: { depth: number }) => {
      node.depth = Math.min(6, node.depth + 1);
    });
  };
}

interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
}

/**
 * Attributes the sanitiser permits but does not produce (§57.1.5).
 *
 * Verified in ADR 0001, and worth restating because the mistake is a natural one: declaring
 * `rel` in the sanitisation schema allows an author to write their own `rel` — it does not
 * add one. Producing the attribute is our job, and it has to happen after sanitisation so
 * that what we add cannot itself be filtered away.
 */
function hardenLinks(siteHost: string) {
  let external = 0;
  const plugin = () => (tree: unknown) => {
    visit(tree as never, "element", (node: HastElement) => {
      if (node.tagName === "a") hardenAnchor(node, siteHost, () => (external += 1));
      if (node.tagName === "code") narrowCodeClass(node);
      if (node.tagName === "img") {
        node.properties["loading"] = "lazy";
        node.properties["decoding"] = "async";
        node.properties["referrerPolicy"] = "no-referrer";
      }
    });
  };
  return { plugin, count: () => external };
}

function hardenAnchor(node: HastElement, siteHost: string, onExternal: () => void) {
  const href = typeof node.properties["href"] === "string" ? node.properties["href"] : null;
  if (href === null) return;

  // Everything here is user-generated, so `ugc` applies to internal links too; the rest of
  // the treatment is for links that leave the site.
  if (href.startsWith("mailto:")) {
    node.properties["rel"] = "ugc nofollow noopener noreferrer";
    return;
  }
  if (!isExternal(href, siteHost)) {
    node.properties["rel"] = "ugc";
    return;
  }
  onExternal();
  node.properties["rel"] = "ugc nofollow noopener noreferrer";
  node.properties["target"] = "_blank";
}

function isExternal(href: string, siteHost: string): boolean {
  if (href.startsWith("/") || href.startsWith("#")) return false;
  try {
    return new URL(href).host !== siteHost;
  } catch {
    return false;
  }
}

/**
 * The default schema allows any class on `<code>`, which is how a highlighting hint
 * survives. Narrowed to the hint alone: an arbitrary class name is a handle onto the
 * site's own stylesheet, and the site's own stylesheet can hide things (§58.2).
 */
const LANGUAGE_CLASS = /^language-[A-Za-z0-9+#._-]{1,32}$/;
function narrowCodeClass(node: HastElement) {
  const className = node.properties["className"];
  if (!Array.isArray(className)) {
    delete node.properties["className"];
    return;
  }
  const kept = className.filter((name) => typeof name === "string" && LANGUAGE_CLASS.test(name));
  if (kept.length === 0) delete node.properties["className"];
  else node.properties["className"] = kept;
}

/**
 * Syntax highlighting, after sanitisation and from the code's own text (SPEC §49.1, §57.1).
 *
 * §49.1 forbids doing this in the browser: a script may exist only for a preference belonging
 * to the reader's own device, and a reader with scripts off must lose nothing but the theme
 * control. So it happens here, once, on the server.
 *
 * **Two properties make it safe, and both are about ordering.** It runs *after* the sanitiser,
 * like `hardenLinks`, so what it produces cannot be filtered away. And it reads the code
 * block's **text** and replaces the node's children wholesale with markup it generated itself
 * — nothing of the author's survives into the highlighted output, so there is no escaping
 * question to get wrong. The classes are `hljs-*` and the site's stylesheet names them; §58.2's
 * concern about an author reaching the site's own stylesheet does not arise, because the author
 * chose a language name from a list and nothing else.
 *
 * **A language is never guessed.** `lowlight` will happily auto-detect, and auto-detection on
 * a four-line fence is a coin toss that produces confidently wrong colours. An unrecognised
 * name renders exactly as it does today.
 *
 * Cost is bounded by the page cache (§33.6): a repeat reader never reaches this module, and a
 * revision is immutable, so the same bytes are highlighted at most once per cache lifetime.
 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** The fence's language, resolved through the alias table, or null if we do not have it. */
function languageOf(node: HastNode): string | null {
  const className = node.properties?.["className"];
  if (!Array.isArray(className)) return null;
  for (const name of className) {
    if (typeof name !== "string" || !name.startsWith("language-")) continue;
    const raw = name.slice("language-".length).toLowerCase();
    const resolved = ALIASES[raw] ?? raw;
    // `registered` honours Prism's own aliases, so `ts` and `yml` resolve without this
    // module having to know about them.
    if (refractor.registered(resolved)) return resolved;
  }
  return null;
}

function highlightCode() {
  return (tree: unknown) => {
    visit(tree as never, "element", (node: HastNode, _index, parent: HastNode | undefined) => {
      // Only a fenced block. `<code>` inside a sentence has no language and no business
      // carrying one.
      if (node.tagName !== "code" || parent?.tagName !== "pre") return;
      const language = languageOf(node);
      if (language === null) return;

      const source = textOf(node);
      // A grammar can throw on input it cannot parse. An article that fails to highlight is
      // an article that renders plainly; it is never an article that fails to render.
      try {
        const highlighted = refractor.highlight(source, language).children as HastNode[];
        for (const child of highlighted) prefixClasses(child);
        if (language === "diff") markDiffLines(node, highlighted);
        node.children = highlighted;
      } catch {
        /* leave the block as it was */
      }
    });
  };
}

/**
 * A diff, where a line has to be a line and the markup does not make it one.
 *
 * Prism wraps each line of a diff in a span whose contents end with the newline that ended
 * that line. For every other language that is exactly right — a span is inline, the newline
 * inside it breaks the line, and the block renders as written.
 *
 * A diff needs more, because the useful thing about one is that a changed line is banded
 * across the full width and findable while scanning a long hunk. That needs a box, and a box
 * put on this markup naively is what shipped: `display: inline-block; width: 100%` inside
 * `white-space: pre`, where lines never wrap — so the second banded line did not move to the
 * next row, it overflowed to the right of the first, and one hunk rendered as a single line
 * with a stray `+` at the far edge.
 *
 * `display: block` breaks between the lines properly. What then remains is the newline still
 * sitting *inside* each box, which would render an empty second row within every line. So it
 * is removed here, at the one place that knows the box is coming — the alternative is CSS
 * compensating for a character it cannot see, which is how this kind of fix stops being
 * understandable a month later.
 *
 * The marker class goes on the `<code>` rather than on each line: a grammar that emits a
 * line shape this function has not anticipated still gets the box, instead of losing its
 * newline and silently running into the line below.
 */
function markDiffLines(code: HastNode, lines: HastNode[]) {
  const className = code.properties?.["className"];
  code.properties = {
    ...(code.properties ?? {}),
    className: Array.isArray(className) ? [...className, "hl-diff"] : ["hl-diff"],
  };

  for (const line of lines) {
    if (line.type !== "element") continue;
    const last = lastTextNode(line);
    if (last?.value?.endsWith("\n")) last.value = last.value.slice(0, -1);
  }
}

/** The last text node in document order under this one, or null if there is none. */
function lastTextNode(node: HastNode): HastNode | null {
  const children = node.children ?? [];
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const found = children[i]!.type === "text" ? children[i]! : lastTextNode(children[i]!);
    if (found !== null) return found;
  }
  return node.type === "text" ? node : null;
}

/**
 * Renames every class the highlighter produced, and the reason is a bug rather than taste.
 *
 * Prism emits `class="token keyword"`, `class="token tag"`, `class="token property"` — short,
 * generic, unprefixed words. This site's stylesheet already had `.token`: the row for an API
 * token on `/settings`, a four-column grid with a bottom border. So every highlighted word in
 * every article became a full-width grid row with a rule under it, and a query rendered one
 * token per line. `.tag` was the next collision waiting, one HTML code block away.
 *
 * The fix is not to rename the site's class. §57.1 already says why: this pipeline renders
 * untrusted content into a page that shares one global stylesheet with the application, and
 * §58.2 makes the point in the other direction — an arbitrary class on user content is a
 * handle onto the site's own stylesheet, which is why `narrowCodeClass` allows only
 * `language-*`. Classes *we* inject into that content are the same hazard from the same
 * cause, so they carry a prefix that the application's own stylesheet never uses. Then no
 * class the site adds later can collide with one an article is rendered with, whichever is
 * written first.
 *
 * The bare `token` marker is dropped rather than prefixed: nothing needs it, and every class
 * that survives here is one more name to keep out of the application's way.
 */
function prefixClasses(node: HastNode) {
  const stack: HastNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const className = current.properties?.["className"];
    if (Array.isArray(className)) {
      const renamed = className
        .filter((name): name is string => typeof name === "string" && name !== "token")
        .map((name) => `hl-${name}`);
      if (renamed.length === 0) delete current.properties!["className"];
      else current.properties!["className"] = renamed;
    }
    for (const child of current.children ?? []) stack.push(child);
  }
}

/** Every text node under this one, concatenated. */
function textOf(node: HastNode): string {
  let out = "";
  const stack: HastNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === "text" && typeof current.value === "string") out += current.value;
    const children = current.children ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
  return out;
}

/**
 * An `id` on every heading, and the contents list built from the same pass (SPEC §49.5).
 *
 * The prefix is not decoration. An `id` derived from text somebody else wrote can collide
 * with an element the page needs to address, and in a browser a named element becomes a
 * property of `document` — which is the DOM-clobbering class the sanitiser's own
 * `clobberPrefix` exists to close. Nothing else on this site uses an `h-` prefix, so nothing
 * of the author's can name anything of ours.
 *
 * Built here rather than by the page, because the page would have to parse the HTML back to
 * find the headings — and two implementations of "what are this article's sections" would be
 * two answers waiting to disagree about one.
 */
function collectHeadings(into: Heading[]) {
  const LEVELS = new Set(["h2", "h3", "h4", "h5", "h6"]);
  const used = new Map<string, number>();

  return () => (tree: unknown) => {
    visit(tree as never, "element", (node: HastNode) => {
      if (node.tagName === undefined || !LEVELS.has(node.tagName)) return;

      const text = textOf(node).trim();
      if (text === "") return;

      const base = slugify(text);
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      const id = seen === 0 ? `h-${base}` : `h-${base}-${seen + 1}`;

      node.properties = { ...(node.properties ?? {}), id };
      into.push({ id, text, depth: Number(node.tagName.slice(1)) });
    });
  };
}

/**
 * Text to the slug half of an id.
 *
 * Written here rather than taken from a library, because the requirement is not "a good slug"
 * — it is a bounded, predictable string that cannot collide with anything of ours. Unicode
 * letters and digits are kept, so a Russian or Chinese heading gets a readable anchor rather
 * than an empty one; everything else becomes a separator. An empty result (a heading of pure
 * punctuation) falls back to `section`, which the de-duplication above then numbers.
 */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug === "" ? "section" : slug;
}

/**
 * Renders article markdown to sanitised HTML.
 *
 * Invisible characters are removed before parsing (§58.2), which means they are removed
 * inside fenced code blocks as well. That is a deliberate cost: an article about zero-width
 * characters cannot display one. Losing that is a fair price for closing the channel that
 * delivers a payload no reviewer can see.
 */
export function renderMarkdown(markdown: string, options: RenderOptions): RenderResult {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const links = hardenLinks(options.siteHost);
  const headings: Heading[] = [];

  try {
    const file = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(enforceLimits(limits))
      .use(demoteHeadings)
      // No `allowDangerousHtml`: raw HTML in the source is dropped, not escaped (§57.1.2).
      .use(remarkRehype)
      .use(rehypeSanitize, SCHEMA)
      // Everything from here down runs after sanitisation, so that what it produces cannot
      // itself be filtered away — the reason is written out over `hardenLinks`.
      .use(links.plugin)
      .use(highlightCode)
      .use(collectHeadings(headings))
      .use(rehypeStringify)
      .processSync(stripInvisible(markdown));

    return { ok: true, html: String(file), externalLinks: links.count(), headings };
  } catch (error) {
    if (error instanceof LimitExceeded) return { ok: false, reason: error.reason };
    throw error;
  }
}

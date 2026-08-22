import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
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

export type RenderResult =
  | { ok: true; html: string; externalLinks: number }
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

  try {
    const file = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(enforceLimits(limits))
      .use(demoteHeadings)
      // No `allowDangerousHtml`: raw HTML in the source is dropped, not escaped (§57.1.2).
      .use(remarkRehype)
      .use(rehypeSanitize, SCHEMA)
      .use(links.plugin)
      .use(rehypeStringify)
      .processSync(stripInvisible(markdown));

    return { ok: true, html: String(file), externalLinks: links.count() };
  } catch (error) {
    if (error instanceof LimitExceeded) return { ok: false, reason: error.reason };
    throw error;
  }
}

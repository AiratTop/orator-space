import termsSource from "../../../../docs/policies/terms.md?raw";
import privacySource from "../../../../docs/policies/privacy.md?raw";
import contentSource from "../../../../docs/policies/content-policy.md?raw";
import { siteOrigin } from "./ports.js";

/**
 * The public policies (SPEC §61.1, §82).
 *
 * One source, two audiences. The Markdown in `docs/policies/` is what a contributor reads,
 * reviews and sends a pull request against; these pages are the same bytes rendered for a
 * reader. Keeping the published text and the reviewable text as one file is the only way
 * the repository's history is a truthful record of what the policy said on a given date,
 * which both documents claim about themselves.
 *
 * Rendered through `renderMarkdown` — the same pipeline, and the same sanitiser, that
 * untrusted article bodies go through (§57.1). There is no second HTML path to get wrong,
 * and a policy page cannot become the one place on the site where raw HTML is allowed.
 */

export type PolicySlug = "terms" | "privacy" | "content-policy";

export interface Policy {
  slug: PolicySlug;
  /** The `# …` line, lifted out so the page has one `h1` rather than two. */
  title: string;
  description: string;
  body: string;
  /**
   * The whole document, title included, for `/{slug}.md` (SPEC §48).
   *
   * Its links are absolute rather than site-relative: a markdown file is a thing that gets
   * copied — into a context window, into a prompt, into somebody's notes — and the copy
   * arrives without the origin it was fetched from. The HTML page keeps the relative form,
   * where the origin is never in doubt.
   */
  markdown: string;
  /** The `**Last updated: …**` line, as an ISO date, for `<time>` and the modified meta. */
  updated: string;
  /**
   * A validator for the markdown (§33.2).
   *
   * Over the bytes, not over the "Last updated" line. A correction that does not move that
   * date is exactly the change a cache must notice, and a validator derived from a date the
   * author has to remember to bump is a validator that does not move when it matters.
   */
  etag: string;
}

const SUMMARY: Record<PolicySlug, string> = {
  terms: "The terms of using Orator.Space — the site, the REST API, MCP and media.",
  privacy:
    "What Orator.Space collects and what it does not. There is no analytics on this site: no Google Analytics, no Yandex.Metrica, no Cloudflare Web Analytics, no third-party script at all.",
  "content-policy":
    "What may be published on Orator.Space, and the licence it carries: everything published here is CC BY 4.0.",
};

const UPDATED = /^\*\*Last updated:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\*\*$/m;

const REPOSITORY = "https://github.com/AiratTop/orator-space/blob/main";

/**
 * Where a relative link in the Markdown points once the document is a web page.
 *
 * The files live in `docs/policies/`, so their links are relative to that directory and
 * are correct when read in the repository. On the site they are not links to anything —
 * a reader would be sent to `/content-policy.md`, which is a 404. The two audiences need
 * two answers, and this table is the second one.
 */
const LINKS: Record<string, string> = {
  "terms.md": "/terms",
  "privacy.md": "/privacy",
  "content-policy.md": "/content-policy",
  "../adr/0008-content-licence.md": `${REPOSITORY}/docs/adr/0008-content-licence.md`,
  "../../SECURITY.md": `${REPOSITORY}/SECURITY.md`,
  "../../SPEC.md": `${REPOSITORY}/SPEC.md`,
};

/**
 * Rewrites those links, and refuses to publish a document containing one it does not know.
 *
 * The refusal is the point. A link added to a policy in a pull request would otherwise ship
 * as a 404 on the live page, discovered by whoever followed it — which on a page whose
 * subject is what you are permitted to do with other people's work is exactly the wrong
 * place for a dead end.
 */
function absoluteLinks(slug: PolicySlug, body: string, origin = ""): string {
  return body.replace(/\]\(([^)\s]+)\)/g, (whole, href: string) => {
    if (/^(https?:|mailto:|#)/.test(href)) return whole;
    const target = LINKS[href];
    if (target === undefined) throw new Error(`policy ${slug} links to ${href}, which has no web address`);
    return `](${target.startsWith("/") ? origin + target : target})`;
  });
}

/**
 * Lifts every heading one level, because the renderer will put it back.
 *
 * `renderMarkdown` demotes headings by one (§57.1): an article body's `#` becomes an `h2`
 * under the page's own `h1`, which is right for a document whose title is rendered by the
 * page. A policy's `##` sections would land at `h3` under an `h1` with no `h2` between them
 * — a level skipped, and §50.1 asks for a correct hierarchy on a page that is indexable.
 *
 * Fence-aware, so a `#` at the start of a line inside a code block stays a comment.
 */
function promoteHeadings(body: string): string {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/^#(#+\s)/, "$1");
    })
    .join("\n");
}

/**
 * FNV-1a, 32-bit. A validator, not a digest.
 *
 * Synchronous, which `crypto.subtle` is not, and this runs at module load. Nothing here is
 * a security boundary: the question a validator answers is "are these the same bytes I
 * already have", and an accidental collision between two versions of a policy is not a
 * threat model, it is a lottery ticket.
 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function parse(slug: PolicySlug, source: string): Policy {
  const lines = source.split("\n");
  const heading = lines.findIndex((line) => line.startsWith("# "));
  if (heading === -1) throw new Error(`policy ${slug} has no title`);

  const updated = UPDATED.exec(source);
  if (updated === null) throw new Error(`policy ${slug} has no "Last updated" line`);

  return {
    slug,
    title: lines[heading]!.slice(2).trim(),
    description: SUMMARY[slug],
    body: promoteHeadings(absoluteLinks(slug, lines.slice(heading + 1).join("\n"))),
    markdown: absoluteLinks(slug, source, siteOrigin),
    updated: updated[1]!,
    etag: `${slug}-${fingerprint(source)}`,
  };
}

export const POLICIES: Record<PolicySlug, Policy> = {
  terms: parse("terms", termsSource),
  privacy: parse("privacy", privacySource),
  "content-policy": parse("content-policy", contentSource),
};

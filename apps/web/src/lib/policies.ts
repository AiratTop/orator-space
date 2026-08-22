import termsSource from "../../../../docs/policies/terms.md?raw";
import privacySource from "../../../../docs/policies/privacy.md?raw";
import contentSource from "../../../../docs/policies/content-policy.md?raw";

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
  /** The `**Last updated: …**` line, as an ISO date, for `<time>` and the modified meta. */
  updated: string;
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
function absoluteLinks(slug: PolicySlug, body: string): string {
  return body.replace(/\]\(([^)\s]+)\)/g, (whole, href: string) => {
    if (/^(https?:|mailto:|#)/.test(href)) return whole;
    const target = LINKS[href];
    if (target === undefined) throw new Error(`policy ${slug} links to ${href}, which has no web address`);
    return `](${target})`;
  });
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
    body: absoluteLinks(slug, lines.slice(heading + 1).join("\n")),
    updated: updated[1]!,
  };
}

export const POLICIES: Record<PolicySlug, Policy> = {
  terms: parse("terms", termsSource),
  privacy: parse("privacy", privacySource),
  "content-policy": parse("content-policy", contentSource),
};

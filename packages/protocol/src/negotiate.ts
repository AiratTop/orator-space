/**
 * Content negotiation (SPEC §48, §33.5).
 *
 * Orator serves the same article as a page, as markdown and as JSON, because being read by
 * a machine is the product rather than a feature of it. The awkward part is that doing this
 * the textbook way — one URL, `Vary: Accept` — destroys the cache: browsers send long
 * `Accept` strings that differ between versions, and every distinct string becomes its own
 * cache entry.
 *
 * So the variants live at separate URLs, `Accept` is a convenience that redirects to them,
 * and the HTML path never carries `Vary: Accept`. This module is the normalisation: the
 * whole header collapses to one of three words before anything else looks at it.
 */
export type Representation = "html" | "markdown" | "json";

/**
 * Normalises an `Accept` header.
 *
 * Order matters, and is not alphabetical. A browser's `Accept` header asks for HTML
 * first and then, further down the same string, for a catch-all wildcard at a lower
 * quality. Any rule that looked for JSON before HTML would therefore hand a browser a
 * JSON document. HTML wins whenever it is acceptable at all, and an absent or
 * unrecognised header is a page — defaulting to a machine format would break every
 * naive client.
 *
 * `application/ld+json` resolves to the JSON representation. JSON-LD is delivered embedded
 * in the page, where crawlers read it (§52); a third URL serving it alone would be a
 * separate cache entry nothing requests.
 */
export function negotiateRepresentation(accept: string | null | undefined): Representation {
  if (!accept) return "html";
  const value = accept.toLowerCase();
  if (value.includes("text/html") || value.includes("application/xhtml")) return "html";
  if (value.includes("text/markdown") || value.includes("text/x-markdown")) return "markdown";
  if (value.includes("application/ld+json") || value.includes("application/json")) return "json";
  return "html";
}

export const CONTENT_TYPES: Record<Representation, string> = {
  html: "text/html; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
};

/** The URL a representation lives at, given the canonical path of the HTML page. */
export function representationPath(canonical: string, representation: Representation): string {
  if (representation === "html") return canonical;
  // The variants hang off the id alone, as the page itself does (§13, ADR 0010). Parsed
  // from the canonical rather than taken as a parameter, so there is one place that knows
  // the shape of an article's address.
  const id = canonical.split("/")[2] ?? "";
  return `/p/${id}.${representation === "markdown" ? "md" : "json"}`;
}

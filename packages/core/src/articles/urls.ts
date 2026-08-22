/**
 * Article URLs (SPEC §11, §13, §14, ADR 0010).
 *
 * An article's address is its identifier. That is the whole of it — there is no slug, no
 * slug history, no redirect table and no resolution step, because there is nothing in the
 * path that anybody may write.
 *
 * What is left is a trailing segment that still resolves. Links made while §13 specified a
 * slug are out in citations and chat logs, and `/p/{id}/anything` redirects to `/p/{id}`
 * permanently rather than 404ing. That is the same promise §13 made, pointing the other way.
 */

export interface SlugSubject {
  id: string;
}

/** Where an article lives. Everything else about it is a redirect to here. */
export const canonicalPath = (article: SlugSubject): string => `/p/${article.id}`;

export type SlugResolution = { kind: "serve" } | { kind: "redirect"; to: string };

/**
 * Decides what to do with a path segment the reader arrived with.
 *
 * Anything at all after the id is a link from before ADR 0010, or somebody's guess. Both
 * move to the canonical address, which is what makes removing the slug free of consequences
 * for anyone holding an old link.
 */
export function resolveSlug(article: SlugSubject, requestedSlug: string | null): SlugResolution {
  return requestedSlug === null || requestedSlug === ""
    ? { kind: "serve" }
    : { kind: "redirect", to: canonicalPath(article) };
}

/** SPEC §7 — a principal's page. The username, never the display name (§49.4). */
export const profilePath = (username: string): string => `/@${username}`;

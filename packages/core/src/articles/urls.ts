/**
 * Article URLs and slug resolution (SPEC §13, §14).
 *
 * The canonical URL carries the id; the slug is decoration. That single decision is what
 * removes the redirect table, the slug-history table and the uniqueness check that every
 * other publishing system carries — any slug resolves, and the wrong one redirects to the
 * right one. The rules below are the whole of it.
 */

export interface SlugSubject {
  id: string;
  slug: string | null;
}

/** Where an article actually lives. Everything else about it is a redirect to here. */
export const canonicalPath = (article: SlugSubject): string =>
  article.slug === null || article.slug === "" ? `/p/${article.id}` : `/p/${article.id}/${article.slug}`;

export type SlugResolution = { kind: "serve" } | { kind: "redirect"; to: string };

/**
 * Decides what to do with the slug the reader arrived with.
 *
 * `requestedSlug` is null when the URL carried none. A stale slug — from an old link, a
 * citation, or a title that has since been rewritten — resolves and redirects rather than
 * 404s, which is the point of putting the id in the path.
 */
export function resolveSlug(article: SlugSubject, requestedSlug: string | null): SlugResolution {
  const canonical = canonicalPath(article);
  const arrived = requestedSlug === null || requestedSlug === "" ? `/p/${article.id}` : `/p/${article.id}/${requestedSlug}`;
  return arrived === canonical ? { kind: "serve" } : { kind: "redirect", to: canonical };
}

/** SPEC §7 — a principal's page. The username, never the display name (§49.4). */
export const profilePath = (username: string): string => `/@${username}`;

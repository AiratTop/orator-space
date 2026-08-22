import type { APIRoute } from "astro";

/**
 * `/p/` is a namespace, not a page (SPEC §11, §13).
 *
 * Every article lives at `/p/{id}`, so the prefix on its own addresses nothing — and a 404
 * there is the wrong answer to what is almost always a truncated link or a person removing
 * path segments to see what is above. The feed is what is above it.
 *
 * 301 rather than 302: this will not become a page later. If a list of every article is ever
 * wanted, it is the sitemap (§51), which exists for exactly that and is not a page.
 */
export const GET: APIRoute = () => new Response(null, { status: 301, headers: { location: "/" } });

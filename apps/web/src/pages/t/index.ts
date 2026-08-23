import type { APIRoute } from "astro";

/**
 * `/t/` is a namespace, not a page (SPEC §22.1, §13).
 *
 * The same rule `/p/` follows, with a different destination: every topic lives at
 * `/t/{slug}`, so the prefix on its own addresses nothing, and a reader who has removed
 * path segments is asking "what is above this". Above a topic is the list of topics, which
 * — unlike the list of every article — is a page a person can read.
 *
 * 301 to `/topics` rather than rendering the index here. Two addresses for one document is
 * the duplication §50.2 spends a section on, and the readable address is the one that gets
 * to keep the content: `/t` is a prefix optimised for the item URLs under it, `/topics` is
 * a word somebody would type.
 */
export const GET: APIRoute = () => new Response(null, { status: 301, headers: { location: "/topics" } });

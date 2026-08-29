import type { APIRoute } from "astro";
import { ErrorType } from "@orator/protocol";
import { CACHE, CDN_CACHE } from "../../lib/http.js";
import { docsOrigin } from "../../lib/ports.js";

/**
 * `https://orator.space/errors/{type}` — the address every problem document advertises.
 *
 * SPEC §45 makes the `type` URI part of the contract and RFC 9457 asks that dereferencing it
 * produce human-readable documentation for that problem type. Until the documentation site
 * existed there was nowhere for it to point, so all eighteen answered 404: every error this
 * platform returns named an address that did not resolve, which is a small dishonesty
 * repeated on every failure.
 *
 * A redirect rather than a page. The catalogue is one table on one page — eighteen pages
 * repeating a shared retry policy would be eighteen places to correct it — and the fragment
 * lands on the row, which is highlighted there by a `:target` rule.
 *
 * 302, not 301. The URI is stable and the *documentation* is not: a browser that cached a
 * permanent redirect would keep sending readers to an address this project can no longer
 * move. The identifier's stability is a promise about the string, never about where it
 * happens to point today.
 */
const KNOWN: ReadonlySet<string> = new Set(Object.values(ErrorType));

export const GET: APIRoute = ({ params }) => {
  const type = params.type ?? "";

  // An unknown name is not redirected to the catalogue. A caller here is dereferencing a
  // `type` it was handed, and answering "here is the list of real ones" for a string that is
  // not one of them turns a typo into a page that looks like it worked.
  if (!KNOWN.has(type)) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": CACHE.private },
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: `${docsOrigin}/start/errors/#${type}`,
      "cache-control": CACHE.policy,
      "cloudflare-cdn-cache-control": CDN_CACHE.policy,
    },
  });
};

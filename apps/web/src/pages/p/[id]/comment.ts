import type { APIRoute } from "astro";
import { createComment } from "@orator/core";
import { commentContext, principalOf, sameOrigin } from "../../../lib/account.js";
import { authPorts, readCookie, SESSION_COOKIE } from "../../../lib/auth.js";
import { resolveSession } from "@orator/core";
import { siteOrigin } from "../../../lib/ports.js";

/**
 * Joining the conversation from a browser (SPEC §17, §49.3).
 *
 * The article page has rendered the chain since Phase 7 and there was no way to add to it
 * without an API token — a network whose claim is that articles answer each other, where a
 * person reading one could not answer it.
 *
 * A separate endpoint rather than a POST on the page, unlike `/settings`. Nothing here is
 * shown once (§42.2), so the redirect that `/settings` could not use is available, and it is
 * the better shape: a refresh after commenting re-renders the article rather than re-posting
 * the comment.
 *
 * The outcome travels as a query parameter. `?comment=…` is a different cache key from the
 * bare article, which would matter if either were cacheable — they are not, because the
 * request carries a cookie and §33.2 makes that `private, no-store`.
 */
const back = (id: string, outcome: string) =>
  new Response(null, {
    status: 303,
    headers: {
      location: `/p/${id}?comment=${outcome}#conversation`,
      "cache-control": "private, no-store",
    },
  });

export const POST: APIRoute = async ({ request, params }) => {
  const id = params.id ?? "";

  // §57.3 — the second lock. The session cookie is SameSite=Lax, so a browser will not
  // attach it to a cross-site form post; this holds on a client that gets Lax wrong.
  if (!sameOrigin(request, siteOrigin)) {
    return new Response("Cross-origin form posts are refused.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
    });
  }

  const cookie = readCookie(request, SESSION_COOKIE);
  const session = cookie === null ? null : await resolveSession(authPorts, cookie);
  if (session === null) return back(id, "signed-out");

  const principal = await principalOf(session.principalId);
  if (principal === null) return back(id, "signed-out");

  const form = await request.formData();
  const body = form.get("body");
  const parent = form.get("parent");

  const stance = form.get("stance");
  const result = await createComment(commentContext(request, principal), id, {
    content: typeof body === "string" ? body : "",
    ...(typeof parent === "string" && parent !== "" ? { parentCommentId: parent } : {}),
    /*
     * §17 — a stance is part of what a comment is on this network, not decoration. The form
     * offers the closed set and defaults to none: a reader with nothing to declare should not
     * be made to pick a posture in order to ask a question.
     */
    ...(typeof stance === "string" && stance !== "" ? { stance: stance as never } : {}),
  });

  /*
   * The failure is named rather than described.
   *
   * A service failure carries a title written for a problem document (§45), and putting it
   * in a URL would put a sentence from the domain into a query string somebody can forge.
   * The page maps a small set of codes to its own words instead.
   */
  if (!result.ok) {
    const code =
      result.error.type === "quota-exceeded"
        ? "rate-limited"
        : result.error.type === "not-found"
          ? "missing"
          : "invalid";
    return back(id, code);
  }

  return back(id, "posted");
};

import type { APIRoute } from "astro";
import { resolveSession, setSaved } from "@orator/core";
import { principalOf, sameOrigin } from "../../../lib/account.js";
import { authPorts, readCookie, SESSION_COOKIE } from "../../../lib/auth.js";
import { readingListPorts, siteOrigin } from "../../../lib/ports.js";

/**
 * Saving an article to read again (SPEC §49.2, ADR 0011).
 *
 * A redirect back rather than a rendered response, like the comment endpoint and for the same
 * reason: nothing here is shown once, so refreshing after saving should re-read the article
 * rather than save it a second time.
 *
 * No JavaScript. The button is a form, its label is the current state, and the state comes
 * from the page — which for a signed-in reader is `private, no-store` (§33.2), so it is never
 * a cached page telling somebody they saved something they did not.
 */
const back = (id: string, outcome: string) =>
  new Response(null, {
    status: 303,
    headers: { location: `/p/${id}?saved=${outcome}`, "cache-control": "private, no-store" },
  });

export const POST: APIRoute = async ({ request, params }) => {
  const id = params.id ?? "";

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
  const wanted = form.get("saved") === "yes";

  const result = await setSaved(readingListPorts, principal.id, id, wanted);
  if (!result.ok) return back(id, "missing");

  return back(id, wanted ? "yes" : "no");
};

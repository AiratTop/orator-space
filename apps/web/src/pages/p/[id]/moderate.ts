import type { APIRoute } from "astro";
import { resolveSession } from "@orator/core";
import { moderationContext, principalOf, sameOrigin } from "../../../lib/account.js";
import { authPorts, readCookie, SESSION_COOKIE } from "../../../lib/auth.js";
import { performModeration } from "../../../lib/moderation-actions.js";
import { siteOrigin } from "../../../lib/ports.js";

/**
 * Acting on an article from the article's own page (SPEC §61.1, §49.2).
 *
 * A sibling route rather than a POST handler on the page, which is the shape `save` and
 * `comment` already use: the page is a `GET` that a cache may hold, and a write that shares
 * its address is a write that has to be excluded from that by hand every time.
 *
 * The outcome comes back as a parameter because there is nowhere else to put it — a redirect
 * carries no body — and it is a single word: the detail belongs in the moderation log (§61.2),
 * not in an address bar that gets pasted into a chat.
 */
const back = (id: string, outcome: "done" | "failed") =>
  new Response(null, {
    status: 303,
    headers: {
      location: `/p/${id}?moderation=${outcome}#moderate-heading`,
      "cache-control": "private, no-store",
    },
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
  if (session === null) return back(id, "failed");

  const principal = await principalOf(session.principalId);
  if (principal === null) return back(id, "failed");

  /*
   * The form is rebuilt rather than forwarded.
   *
   * `performModeration` is the queue's dispatcher and takes the queue's fields; this page has
   * no report to close and must not be able to name one. Naming the target here — from the
   * URL, not from the form — means a moderator cannot be made to act on something else by a
   * hidden field somebody else wrote.
   */
  const submitted = await request.formData();
  const form = new FormData();
  form.set("action", "moderation.act");
  form.set("target-type", "article");
  form.set("target", id);
  form.set("kind", String(submitted.get("kind") ?? ""));
  form.set("reason", String(submitted.get("reason") ?? ""));

  const outcome = await performModeration(moderationContext(request, principal), form);
  return back(id, outcome.kind === "done" ? "done" : "failed");
};

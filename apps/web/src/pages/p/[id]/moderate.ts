import type { APIRoute } from "astro";
import { resolveSession } from "@orator/core";
import { moderationContext, moderationPorts, principalOf, sameOrigin } from "../../../lib/account.js";
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
  const comment = String(submitted.get("comment") ?? "");

  /*
   * A comment is named by the form, and checked against the article in the URL.
   *
   * The article case takes its target from the address precisely so a hidden field cannot
   * redirect the action; a comment has no address of its own, so the id has to come from the
   * form and the guard moves here instead. A comment that belongs to another article is
   * refused rather than acted on: without this, one moderator's click could be aimed at any
   * comment on the site by anyone who could get them to submit this form.
   */
  if (comment !== "") {
    const found = await moderationPorts.social.findComment(comment);
    if (found === null || found.articleId !== id) return back(id, "failed");
  }

  const form = new FormData();
  form.set("action", "moderation.act");
  form.set("target-type", comment === "" ? "article" : "comment");
  form.set("target", comment === "" ? id : comment);
  form.set("kind", String(submitted.get("kind") ?? ""));
  form.set("reason", String(submitted.get("reason") ?? ""));

  const outcome = await performModeration(moderationContext(request, principal), form);
  return back(id, outcome.kind === "done" ? "done" : "failed");
};

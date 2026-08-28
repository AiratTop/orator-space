import type { APIRoute } from "astro";
import { atomFeed, FEED_ENTRIES, loadProfile } from "@orator/core";
import { feedPaths, feedResponse } from "../../lib/feeds.js";
import { ports, siteOrigin } from "../../lib/ports.js";

/**
 * One author's feed (SPEC §7, §48, §49.2).
 *
 * A person or an agent — §7 gives them one namespace, and following one is the same act. The
 * handle arrives with its `@`, like every other address on this site, and a request without
 * one is not a profile: the check is here rather than in a rewrite so that `/feed.xml` at the
 * root cannot be reached through this route by a client that guessed.
 */
export const GET: APIRoute = async ({ params }) => {
  const handle = params.handle ?? "";
  if (!handle.startsWith("@")) return new Response("Not found", { status: 404 });

  const username = handle.slice(1);
  const result = await loadProfile(ports, username, { tab: "articles", limit: FEED_ENTRIES });
  if (!result.ok) return new Response("No profile at that address", { status: 404 });

  const { principal, content } = result.value;
  const name = principal.displayName ?? `@${principal.username}`;

  return feedResponse(
    atomFeed(
      {
        self: `${siteOrigin}${feedPaths.author(principal.username)}`,
        alternate: `${siteOrigin}/@${principal.username}`,
        origin: siteOrigin,
        title: `${name} — Orator.Space`,
        subtitle: principal.bio,
      },
      content.tab === "articles" ? content.page.cards : [],
    ),
  );
};

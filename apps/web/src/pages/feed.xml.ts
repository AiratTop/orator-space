import type { APIRoute } from "astro";
import { atomFeed, FEED_ENTRIES, latestFeed } from "@orator/core";
import { feedPaths, feedResponse } from "../lib/feeds.js";
import { ports, siteOrigin } from "../lib/ports.js";

/**
 * The site's feed (SPEC §48, §49.2).
 *
 * The same query as the front page, rendered for a reader's client rather than for a browser.
 * Everything the feed excludes — a duplicate (§60.1), a hidden article, the canary (§66.7) —
 * it excludes because `latestFeed` does, which is the point of going through the same service:
 * a feed that decided for itself what to list would be a second, quieter set of listing rules
 * for somebody to discover the hard way.
 */
export const GET: APIRoute = async () => {
  const feed = await latestFeed(ports, { limit: FEED_ENTRIES });

  return feedResponse(
    atomFeed(
      {
        self: `${siteOrigin}${feedPaths.site}`,
        alternate: `${siteOrigin}/`,
        origin: siteOrigin,
        title: "Orator.Space",
        subtitle:
          "An open publishing network where people and autonomous agents publish, read, cite and challenge each other.",
      },
      feed.cards,
    ),
  );
};

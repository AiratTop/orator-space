import type { APIRoute } from "astro";
import { atomFeed, FEED_ENTRIES, loadTopic } from "@orator/core";
import { feedPaths, feedResponse } from "../../../lib/feeds.js";
import { siteOrigin, topicPorts } from "../../../lib/ports.js";

/**
 * One topic's feed (SPEC §22, §48).
 *
 * The most useful of the three, and the reason the vocabulary was worth building: a reader
 * who wants inference and not everything else can have exactly that, in the reader they
 * already use. A section's feed carries its leaves' articles, once each, because `loadTopic`
 * already answers that question for the page.
 */
export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug ?? "";
  const result = await loadTopic(topicPorts, slug, { limit: FEED_ENTRIES });
  if (!result.ok) return new Response("No topic at that address", { status: 404 });

  const { topic, cards } = result.value;
  return feedResponse(
    atomFeed(
      {
        self: `${siteOrigin}${feedPaths.topic(topic.slug)}`,
        alternate: `${siteOrigin}/t/${topic.slug}`,
        origin: siteOrigin,
        title: `${topic.label} — Orator.Space`,
        subtitle: topic.description,
      },
      cards,
    ),
  );
};

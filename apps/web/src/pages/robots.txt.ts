import type { APIRoute } from "astro";
import { INDEX_KEY } from "@orator/core";
import { apiOrigin, assets, mcpOrigin, siteOrigin } from "../lib/ports.js";

/**
 * SPEC §48 — an explicit, deliberate policy on AI crawlers.
 *
 * The default position is that reading is permitted, because the platform exists for
 * machine consumption of content. Blocking AI crawlers here would contradict the product:
 * an article nobody's model may read is an article Orator had no reason to host.
 *
 * What the file does not do is invite crawling of everything. `/p/{id}.md` and
 * `/p/{id}.json` are the same document as the page and are marked `noindex` in their
 * headers already; naming them here keeps a crawler from spending its budget discovering
 * that three times over. Whether an individual article is indexable at all is decided per
 * article, not here (§50.3).
 *
 * The `Sitemap:` line appears only once there is a sitemap. §51 builds it on a cron, so a
 * newly created environment serves nothing at that address for the first five minutes, and
 * naming a file that returns 404 teaches a crawler that this site's directives are
 * unreliable. One small R2 read per hour of edge cache buys the difference.
 */
export const GET: APIRoute = async () => {
  const built = (await assets.get(INDEX_KEY)) !== null;

  return new Response(
    [
      "# Orator.Space — an open publishing network for humans and AI agents.",
      "# Reading is permitted. The API and MCP are better addresses than this one:",
      `#   ${apiOrigin}   ${mcpOrigin}   /llms.txt`,
      "",
      "User-agent: *",
      "Allow: /",
      "",
      "# Machine representations duplicate the page they belong to.",
      "Disallow: /*.md$",
      "Disallow: /*.json$",
      "",
      ...(built ? [`Sitemap: ${siteOrigin}/sitemap.xml`, ""] : []),
    ].join("\n"),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
};

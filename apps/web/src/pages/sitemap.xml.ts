import type { APIRoute } from "astro";
import { INDEX_KEY } from "@orator/core";
import { assets } from "../lib/ports.js";

/**
 * SPEC §51 — the shard index, served from the apex.
 *
 * A read of one R2 object. Nothing is generated here: §51 is explicit that building on
 * demand is a read of the whole article table on every crawler request, and the file this
 * serves was written by the five-minute cron in the edge worker.
 *
 * A 404 before the first build is the honest answer, and it is why `robots.txt` names the
 * sitemap only once there is something at the address (see below).
 */
export const GET: APIRoute = async () => {
  const body = await assets.get(INDEX_KEY);
  if (body === null) return new Response("No sitemap has been built yet", { status: 404 });

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
      "cloudflare-cdn-cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
};

import type { APIRoute } from "astro";
import { shardObjectKey } from "@orator/core";
import { assets } from "../../lib/ports.js";

/**
 * SPEC §51 — one shard, which is one month of publications (ADR 0009).
 *
 * The shard name is validated against the shape rather than passed through. It becomes an
 * R2 key, and a key built from an unchecked path segment is a way to ask this endpoint for
 * any object in the bucket — today that is only sitemaps, which is exactly the kind of
 * "only" that stops being true after one more feature.
 */
const SHARD = /^articles-\d{4}-\d{2}$/;

export const GET: APIRoute = async ({ params }) => {
  const name = params.shard ?? "";
  if (!SHARD.test(name)) return new Response("Not found", { status: 404 });

  const body = await assets.get(shardObjectKey(name.replace(/^articles-/, "")));
  if (body === null) return new Response("Not found", { status: 404 });

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
      "cloudflare-cdn-cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
};

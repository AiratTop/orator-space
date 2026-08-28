import type { APIRoute } from "astro";
import { PAGES_KEY, shardObjectKey, TOPICS_KEY } from "@orator/core";
import { assets } from "../../lib/ports.js";

/**
 * SPEC §51 — one shard, which is one month of publications (ADR 0009).
 *
 * The shard name is validated against the shape rather than passed through. It becomes an
 * R2 key, and a key built from an unchecked path segment is a way to ask this endpoint for
 * any object in the bucket — today that is only sitemaps, which is exactly the kind of
 * "only" that stops being true after one more feature.
 */
/*
 * `topics` was missing from this list until 2026-08-28, and nothing noticed for a fortnight.
 *
 * The cron wrote `sitemaps/topics.xml` and the index linked it; this route answered 404,
 * so §51's topic shard was unreachable from the moment it was built. It went unseen because
 * it was never built: the file is written only when a topic has three indexable articles,
 * and nothing on any deployment was indexable (PLAN §13.3). The first deployment to have the
 * state found the bug in the first minute.
 */
const SHARD = /^(pages|topics|articles-\d{4}-\d{2})$/;

export const GET: APIRoute = async ({ params }) => {
  const name = params.shard ?? "";
  if (!SHARD.test(name)) return new Response("Not found", { status: 404 });

  const key =
    name === "pages"
      ? PAGES_KEY
      : name === "topics"
        ? TOPICS_KEY
        : shardObjectKey(name.replace(/^articles-/, ""));
  const body = await assets.get(key);
  if (body === null) return new Response("Not found", { status: 404 });

  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
      "cloudflare-cdn-cache-control": "public, max-age=300, stale-while-revalidate=3600",
    },
  });
};

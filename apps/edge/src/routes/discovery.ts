import { Hono } from "hono";
import { feed, search, searchPrincipals, type RequestContext } from "@orator/core";
import { decodeFeedCursor, encodeFeedCursor, schemas } from "@orator/protocol";
import { semanticFor } from "../context.js";
import { page, parseQuery, problemResponse, respond } from "../http.js";
import { cardView, topicView } from "../views.js";
import type { Env } from "../index.js";

/**
 * REST adapter for the feed, search and topics (SPEC §44.1).
 *
 * All three are anonymous. §48 is explicit that requiring a key to read what is already
 * public is pointless, and discovery is the surface an agent reaches before it has any
 * reason to hold credentials.
 */

type Vars = { requestId: string; ctx: RequestContext };

export const discoveryRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

discoveryRoutes.get("/v1/feed", async (c) => {
  const parsed = parseQuery(c, schemas.feedQuery);
  if ("response" in parsed) return parsed.response;

  const page = await feed(c.get("ctx").ports, {
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
    before: decodeFeedCursor(parsed.data.cursor),
  });

  return respond(c, {
    ok: true,
    value: {
      items: page.cards.map(cardView),
      next_cursor: page.next === null ? null : encodeFeedCursor(page.next),
    },
  });
});

discoveryRoutes.get("/v1/search", async (c) => {
  const parsed = parseQuery(c, schemas.searchQuery);
  if ("response" in parsed) return parsed.response;

  const ports = c.get("ctx").ports;

  if (parsed.data.type === "principals") {
    const result = await searchPrincipals(ports, parsed.data.q);
    if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);
    return respond(c, {
      ok: true,
      value: {
        query: result.value.query,
        principals: result.value.principals.map((principal) => ({
          id: principal!.id,
          kind: principal!.kind,
          username: principal!.username,
          display_name: principal!.displayName,
          bio: principal!.bio,
        })),
        next_cursor: null,
      },
    });
  }

  /*
   * §38.2, ADR 0012 — the semantic leg is assembled here rather than carried on `Ports`.
   *
   * It is a property of the deployment, not of the request: a Worker either has the two
   * bindings or has neither, and `Ports` is the set of things every service can assume
   * exists. Adding an optional member there would make every service that never touches it
   * carry the question of whether it is present.
   */
  const semantic = semanticFor(c.env);
  const result = await search(
    { ...ports, ...(semantic === undefined ? {} : { semantic }) },
    parsed.data.q,
    { ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }) },
  );
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  return respond(c, {
    ok: true,
    value: {
      query: result.value.query,
      articles: result.value.articles.map(cardView),
      // Ranked results are not keyset-paginable; §38 explains why this is null rather than
      // an offset, and the OpenAPI description says the same thing to a client.
      next_cursor: null,
    },
  });
});

discoveryRoutes.get("/v1/topics", async (c) => {
  const topics = await c.get("ctx").ports.topics.list();
  return respond(c, {
    ok: true,
    value: {
      items: topics.map(topicView),
      next_cursor: null,
    },
  });
});

discoveryRoutes.get("/v1/topics/:slug/articles", async (c) => {
  const parsed = parseQuery(c, schemas.paginationQuery);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const topic = await ctx.ports.topics.findBySlug(c.req.param("slug"));
  if (topic === null) {
    return problemResponse(c, { type: "not-found", title: "Topic not found" });
  }
  const limit = parsed.data.limit ?? 20;
  const { rows: cards, nextCursor } = page(
    await ctx.ports.topics.listArticles(topic.id, limit + 1, parsed.data.cursor ?? null),
    limit,
  );
  return respond(c, {
    ok: true,
    value: {
      items: cards.map(cardView),
      next_cursor: nextCursor,
    },
  });
});

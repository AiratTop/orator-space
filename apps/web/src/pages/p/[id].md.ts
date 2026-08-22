import type { APIRoute } from "astro";
import { loadBody } from "@orator/core";
import { canonicalUrlOf, gateArticle, validatorsFor } from "../../lib/article.js";
import { representationResponse } from "../../lib/http.js";
import { ports } from "../../lib/ports.js";

/**
 * `/p/{id}.md` — the article as its source markdown (SPEC §48).
 *
 * Its own URL rather than a `Vary: Accept` variant of the page, so it carries its own
 * stable cache key (§33.5). No slug in the path: one document, one machine-readable
 * address, one cache entry.
 *
 * The bytes are the author's markdown with invisible characters removed (§58.2), and
 * nothing further. There is nothing further to do: markdown served as `text/markdown`
 * under `nosniff` executes nothing. What it can still carry is an instruction aimed at
 * whatever model reads it, and no amount of escaping addresses that — §58.3 places that
 * responsibility on the client, and the JSON representation carries the label that says so.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const gate = await gateArticle(request, params.id ?? "", { negotiate: false, entity: "revision" });
  if (gate.kind === "response") return gate.response;
  if (gate.kind === "missing") return new Response("Not found\n", { status: 404 });

  const body = await loadBody(ports, gate.article.view);
  if (!body.ok) return new Response("Content unavailable\n", { status: 503 });

  return representationResponse(body.value, "markdown", {
    validators: validatorsFor(gate.article, "revision"),
    canonicalUrl: canonicalUrlOf(gate.article),
  });
};

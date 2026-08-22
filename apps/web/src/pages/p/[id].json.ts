import type { APIRoute } from "astro";
import { loadBody, untrustedEnvelope, verifyProvenance } from "@orator/core";
import { canonicalUrlOf, gateArticle, validatorsFor } from "../../lib/article.js";
import { representationResponse } from "../../lib/http.js";
import { ports, siteOrigin } from "../../lib/ports.js";

/**
 * `/p/{id}.json` — the article as structured data (SPEC §48, §58.2).
 *
 * This is the representation agents consume, so it is the one that carries the §58.2
 * envelope: the body arrives wrapped in a statement of what it is, who wrote it, whether
 * that authorship was cryptographically verified, and — first field a parser reaches —
 * that it is untrusted. An agent has no other way to know, and the whole threat in §58.1
 * is that it will not think to ask.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const gate = await gateArticle(request, params.id ?? "", { negotiate: false, entity: "revision" });
  if (gate.kind === "response") return gate.response;
  if (gate.kind === "missing") {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const { article } = gate;
  const body = await loadBody(ports, article.view);
  if (!body.ok) {
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const provenance = await verifyProvenance(article.view);
  const { view } = article;

  const payload = {
    schema_version: 1,
    id: view.article.id,
    url: canonicalUrlOf(article),
    title: view.revision.title,
    excerpt: view.revision.excerpt,
    language: view.article.language,
    published_at: view.article.publishedAt,
    revision: {
      id: view.revision.id,
      content_hash: view.revision.contentHash,
      content_bytes: view.revision.contentBytes,
      reading_time_seconds: view.revision.readingTimeSeconds,
      created_at: view.revision.createdAt,
    },
    author: {
      username: view.author.username,
      kind: view.author.kind,
      display_name: view.author.displayName,
      owner_username: view.author.ownerUsername,
      model: view.author.model,
      url: `${siteOrigin}/@${view.author.username}`,
    },
    content: untrustedEnvelope(view, body.value, provenance, siteOrigin),
  };

  return representationResponse(JSON.stringify(payload, null, 2), "json", {
    validators: validatorsFor(article, "revision"),
    canonicalUrl: canonicalUrlOf(article),
  });
};

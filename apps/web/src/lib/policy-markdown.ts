import { POLICIES, type PolicySlug } from "./policies.js";
import { representationResponse } from "./http.js";
import { siteOrigin } from "./ports.js";

/**
 * `/{slug}.md` — a policy as its source markdown (SPEC §48, §61.1).
 *
 * The same argument §48 makes about articles, applied to the documents that say what may be
 * done with them. These are read by models more than by people: an agent deciding whether it
 * may train on this corpus should be able to fetch the licence as text rather than parse it
 * out of a rendered page, and it needs no API key to do so.
 *
 * No JSON variant. There is nothing structured here to offer — a policy is prose, and a JSON
 * envelope around one string would be a second address serving the same bytes with more
 * ceremony (§50.2).
 *
 * `X-Robots-Tag: noindex` and a canonical header naming the HTML page, exactly as the
 * article variants carry: one document indexed once, at the address a person is sent to.
 */
export function policyMarkdown(slug: PolicySlug): Response {
  const policy = POLICIES[slug];

  return representationResponse(policy.markdown, "markdown", {
    validators: { etag: policy.etag, lastModified: `${policy.updated}T00:00:00.000Z` },
    canonicalUrl: `${siteOrigin}/${slug}`,
    policy: "policy",
  });
}

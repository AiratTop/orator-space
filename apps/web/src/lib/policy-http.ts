import { negotiateRepresentation } from "@orator/protocol";
import { POLICIES, type Policy, type PolicySlug } from "./policies.js";
import {
  CACHE,
  CDN_CACHE,
  cacheHeaders,
  composedEtag,
  negotiatedRedirect,
  notModified,
  representationResponse,
  type Validators,
} from "./http.js";
import { siteOrigin } from "./ports.js";

/**
 * The HTTP half of the policies (SPEC §33, §48, §61.1).
 *
 * `policies.ts` parses the three documents and knows nothing about requests; this decides
 * what a request for one gets back. Both routes for a policy — the page and its `.md` —
 * live here so the two cannot drift on the thing that has already gone wrong twice: which
 * validator a response carries.
 */

/**
 * A policy's validator.
 *
 * The bytes of the document, plus the build. Neither alone is the entity: the fingerprint
 * misses a change to the template or to the link table that rewrites `privacy.md` into
 * `/privacy`, and the build alone would change the validator on every deployment whether or
 * not the document had. Together they move exactly when the response does.
 */
const validatorsFor = (policy: Policy, representation: "page" | "markdown"): Validators => ({
  // Two representations of one document are two entities, and an ETag names an entity.
  // They live at different URLs so no cache could confuse them today, but a validator that
  // is accidentally shared is a trap laid for whoever adds the third representation.
  etag: composedEtag(representation === "page" ? policy.etag : `${policy.etag}.md`),
  lastModified: `${policy.updated}T00:00:00.000Z`,
});

/**
 * What a request for a policy *page* gets before the page renders.
 *
 * Returns a Response to send instead, or the validators the page should carry. Called from
 * the three `.astro` pages rather than from the shared component, because only a page may
 * return a Response — a `return` in a component's frontmatter ends the frontmatter and
 * renders the page anyway, which is what it did here for one commit's worth of confusion.
 */
export function policyGate(request: Request, slug: PolicySlug): Response | Validators {
  /*
   * §33.5 — `Accept` is the secondary mechanism, and it redirects.
   *
   * The same behaviour the article page has, for the same reason: a machine that asked for
   * markdown and was handed HTML has to notice and ask again. `Accept: text/markdown` is
   * not what a browser sends, so nothing a person does reaches this.
   */
  if (negotiateRepresentation(request.headers.get("accept")) === "markdown") {
    return negotiatedRedirect(`/${slug}.md`);
  }

  const validators = validatorsFor(POLICIES[slug], "page");
  return notModified(request, validators, "policy") ?? validators;
}

/** Applies what `policyGate` returned. Separate only so the page reads as three lines. */
export function policyHeaders(headers: Headers, validators: Validators): void {
  cacheHeaders(headers, CACHE.policy, CDN_CACHE.policy, validators);
}

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
 *
 * Unlike an article's `.md`, this one carries the build in its validator. An article's
 * markdown is the author's bytes; a policy's is assembled here, with its repository-relative
 * links rewritten to absolute ones by a table that lives in the code.
 */
export function policyMarkdown(slug: PolicySlug): Response {
  const policy = POLICIES[slug];

  return representationResponse(policy.markdown, "markdown", {
    validators: validatorsFor(policy, "markdown"),
    canonicalUrl: `${siteOrigin}/${slug}`,
    policy: "policy",
  });
}

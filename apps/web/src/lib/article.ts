import {
  canonicalPath,
  loadArticle,
  type ArticleView,
  type Provenance,
  type PublicArticle,
  type RenderFailure,
} from "@orator/core";
import { isOratorId, negotiateRepresentation, representationPath } from "@orator/protocol";
import { composedEtag, negotiatedRedirect, notModified, type Validators } from "./http.js";
import { ports, siteOrigin } from "./ports.js";

/**
 * The gate every article route passes through (SPEC §13, §33, §48).
 *
 * The page, the `.md` variant and the `.json` variant answer the same questions in the same
 * order — does this exist, is the address right, has the reader already got it — and only a
 * route that gets past all three pays for the body. Written once because the order *is* the
 * contract: checking `If-None-Match` before the representation redirect would return 304 for a URL
 * about to move, and reading R2 before the 304 would make §33.3 a lie.
 */

export type ArticleGate =
  | { kind: "response"; response: Response }
  | { kind: "missing" }
  | { kind: "ok"; article: PublicArticle };

export interface GateOptions {
  /** Whether `Accept` may redirect to another representation. False on the variants. */
  negotiate: boolean;
  /**
   * Which entity this route serves.
   *
   * Three, because there are three answers to "what would change these bytes".
   *
   *   page      the article, the conversation below it (§76) and the template
   *   envelope  the revision and the JSON shape this build wraps it in (§58.2)
   *   revision  the author's markdown, and nothing else
   *
   * Stated per route rather than inferred: getting it wrong means serving something stale
   * rather than failing visibly, which is the class of bug this whole gate exists to avoid.
   */
  entity: "page" | "envelope" | "revision";
}

/**
 * SPEC §33.2 — what the route sends, and what it compares `If-None-Match` against.
 *
 * The first two carry the build (see `composedEtag`). A deployment changes the page's
 * markup and the envelope's field names; it does not change what an author wrote, so the
 * third is the content hash alone and a redeploy does not cost every reader a re-fetch of
 * every article body.
 */
export const validatorsFor = (article: PublicArticle, entity: GateOptions["entity"]): Validators => {
  switch (entity) {
    case "page":
      return { etag: composedEtag(article.pageEtag), lastModified: article.pageLastModified };
    case "envelope":
      return { etag: composedEtag(article.etag), lastModified: article.lastModified };
    case "revision":
      return { etag: article.etag, lastModified: article.lastModified };
  }
};

export async function gateArticle(
  request: Request,
  id: string,
  options: GateOptions,
): Promise<ArticleGate> {
  // An id that cannot be one is not a database question. Checking the shape first keeps a
  // crawler walking nonsense URLs off D1 entirely.
  if (!isOratorId(id)) return { kind: "missing" };

  const loaded = await loadArticle(ports, id);
  if (!loaded.ok) return { kind: "missing" };
  const article = loaded.value;

  if (options.negotiate) {
    // §33.5 — `Accept` redirects to the variant's own URL.
    const wanted = negotiateRepresentation(request.headers.get("accept"));
    if (wanted !== "html") {
      return {
        kind: "response",
        response: negotiatedRedirect(representationPath(article.canonicalPath, wanted)),
      };
    }
  }

  const revalidated = notModified(request, validatorsFor(article, options.entity));
  if (revalidated !== null) return { kind: "response", response: revalidated };

  return { kind: "ok", article };
}

export const canonicalUrlOf = (article: PublicArticle): string =>
  `${siteOrigin}${article.canonicalPath}`;

/**
 * JSON-LD for an article (SPEC §52).
 *
 * The document, not its text: serialising it is `Layout`'s job, because a title is untrusted
 * text and the escaping that makes it safe inside a `<script>` belongs where the string
 * meets the HTML (`jsonLdDocument`).
 *
 * An agent author is an `Organization` with `additionalType: AIAgent`. schema.org has no
 * type for a machine author, and marking an agent as a `Person` would put a false statement
 * in the one part of the page that exists to be believed by machines (§10). `Organization`
 * is the closest true thing available.
 */
export function articleJsonLd(view: ArticleView, provenance: Provenance): Record<string, unknown> {
  const { article, revision, author } = view;
  const isAgent = author.kind === "agent";

  return {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": `${siteOrigin}${canonicalPath(article)}`,
    headline: revision.title,
    ...(revision.excerpt === null ? {} : { description: revision.excerpt }),
    inLanguage: article.language,
    author: {
      "@type": isAgent ? "Organization" : "Person",
      name: `@${author.username}`,
      url: `${siteOrigin}/@${author.username}`,
      ...(isAgent ? { additionalType: "https://orator.space/ns/AIAgent" } : {}),
    },
    publisher: { "@type": "Organization", name: "Orator.Space", url: siteOrigin },
    datePublished: article.publishedAt,
    dateModified: revision.createdAt,
    // §10 — disclosure travels with the structured data, not only the visible page. A
    // crawler reading only JSON-LD must not come away thinking a human wrote this.
    creativeWorkStatus: article.authorshipDisclosure,
    ...(provenance === "verified" ? { "https://orator.space/ns/signatureVerified": true } : {}),
    ...(article.canonicalUrl === null ? {} : { isBasedOn: article.canonicalUrl }),
  };
}

/** Why a body is not on the page, in words a reader can act on. */
export const FAILURE_MESSAGE: Record<RenderFailure | "unavailable", string> = {
  "too-deep": "This article is nested too deeply to render safely.",
  "too-many-nodes": "This article is too large to render safely.",
  "table-too-large": "This article contains a table too large to render safely.",
  unavailable: "This article's content is temporarily unavailable.",
};

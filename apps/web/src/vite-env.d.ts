/**
 * Vite's `?raw` import, typed.
 *
 * The policy pages read their Markdown from `docs/policies/` rather than keeping a second
 * copy under `src/`, and this is the declaration that makes that a typed import instead of
 * an `any`.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}

/** The build identity, defined by Vite at compile time. See `astro.config.mjs`. */
declare const __BUILD_ID__: string;

/**
 * What the middleware resolved about the reader, once per request (SPEC §49.2, §61.1).
 *
 * `undefined` for an anonymous request, which is nearly all of them: nothing is resolved
 * unless a session cookie is present, so the cached path costs nothing. The masthead reads
 * this to decide whether to offer the moderation section — a link that appears for one
 * reader and not another, which is safe only because §33.2's rule in the same middleware
 * makes every credentialed response `private, no-store`.
 */
declare namespace App {
  interface Locals {
    viewer?: {
      principalId: string;
      username: string;
      moderator: boolean;
    };
  }
}

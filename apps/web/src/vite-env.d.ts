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

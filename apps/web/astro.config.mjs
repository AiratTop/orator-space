// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// SPEC §49.1 — server-rendered, minimal JavaScript. Bindings are read via
// `import { env } from "cloudflare:workers"`; Astro.locals.runtime.env was
// removed in Astro v6 (ADR 0001).
export default defineConfig({
  output: "server",
  // Orator keeps sessions in D1 (SPEC §9.1). Left at its default the adapter would
  // provision a KV namespace for Astro's own session store — a binding we would never
  // write to, and a storage layer SPEC §30 deliberately excludes from the MVP.
  session: false,
  // The dev toolbar is the only thing on this site that injects an inline script, and
  // `script-src 'self'` (SPEC §57.2) blocks it. Rather than relax the policy in
  // development — which would mean the CSP is never actually exercised until deployment —
  // the toolbar is switched off, and one policy holds everywhere. HMR is unaffected: it
  // loads as a module from the origin.
  devToolbar: { enabled: false },
  adapter: cloudflare({
    imageService: "passthrough",
    // Both Workers share one D1 and one R2 in every deployed environment (§63). By
    // default each local dev server keeps its own miniflare state, so an article
    // published through the API would be invisible to the web app — the two would
    // disagree locally and nowhere else, which is the worst place for a difference to
    // live. An absolute path, because the two servers resolve relative paths from
    // different working directories.
    persistState: { path: fileURLToPath(new URL("../../.wrangler-state", import.meta.url)) },
  }),
  site: "https://orator.space",
});

// @ts-check
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
  adapter: cloudflare({ imageService: "passthrough" }),
  site: "https://orator.space",
});

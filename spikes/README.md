# spikes/

Throwaway verification harnesses. **Not project scaffolding** — see `PLAN.md` §2.

| Spike | Verifies | Result |
|---|---|---|
| `platform/` | crypto, D1, R2, Durable Objects, Queues, markdown pipeline, WebAuthn | `docs/adr/0001-platform-constraints.md` |
| `astro/` | Astro SSR + Cloudflare adapter: bindings, response headers, output layout | same |

Run: `cd platform && npm install && npx wrangler dev --local`, then `curl localhost:8787`.

These directories are deleted once Phase 0 replaces them with the real monorepo. They are kept meanwhile so the ADR's claims stay reproducible.

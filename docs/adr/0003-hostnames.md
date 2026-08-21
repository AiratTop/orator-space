# ADR 0003 — Environment hostnames stay one level deep

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-21 |
| **Phase** | 0 |

## Context

`PLAN.md` originally specified `*.staging.orator.space` for the staging environment,
mirroring production as `api.staging.orator.space`, `mcp.staging.orator.space` and so on.

Cloudflare's Universal SSL certificate covers the zone apex and **one** level of
subdomain. `api.staging.orator.space` is two levels deep and is therefore not covered.

## Why this matters more than it looks

The failure is not a refused deployment. `wrangler deploy` attaches the custom domain and
reports success; DNS resolves; the Worker is live. Only the TLS handshake fails, and only
for that hostname. A deployment that reports success while being unreachable is
considerably worse than one that fails outright, because nothing draws attention to it.

Covering a second level requires a dedicated certificate — a recurring cost for the shape
of a hostname.

## Decision

Environment is a suffix on a single-level label:

```
production   api.orator.space           mcp.orator.space           media.orator.space
staging      api-staging.orator.space   mcp-staging.orator.space   media-staging.orator.space
web          orator.space               staging.orator.space
```

`surfaceFor()` strips a trailing `-staging` (or `-preview`) before matching, so one code
path serves every environment. The tests pin the near-misses too — `docs-staging` and
`apibogus` must not resolve to a surface, which a looser prefix match would wrongly claim.

## Verified

All hostnames answer with a valid certificate (`ssl_verify_result=0`), issued for
`CN=orator.space` by Google Trust Services.

One hostname appeared broken during verification: `api.orator.space` refused connections
from the development machine while `mcp` and `media` worked. The cause was local —
`/etc/hosts` maps `api.orator.space`, `app.orator.space` and `docs.orator.space` to
`127.0.0.1`. Forcing resolution through Cloudflare returned a healthy production response.

Worth recording because the symptom pointed convincingly at certificate provisioning, and
because production hostnames aliased to localhost will keep producing false failures until
those entries are removed.

## Consequence for the redirect rule

`www.orator.space` has a redirect rule but **no DNS record**, so nothing reaches Cloudflare
and the rule never runs. A proxied record is required for the hostname to exist at all.

import { env } from "cloudflare:workers";

/**
 * Where this deployment lives, and where its siblings do (SPEC §14.1, §14.3, §57.4, ADR 0003).
 *
 * Its own module, and small on purpose. These are configuration rather than ports, and the
 * middleware needs them — for §57.2's `img-src` — on every request, including the ones that
 * never touch a database. Importing `ports.ts` for an address would drag every adapter into
 * that path and imply the middleware could use them.
 */
interface HostEnv {
  SITE_HOST: string;
  /** `production`, `staging` or `local` — SPEC §63, and the wrangler config's `vars`. */
  ENVIRONMENT: string;
  /**
   * SPEC §9.3 — the bot a deep link points at.
   *
   * A variable rather than a secret: the name is public, it is in every link the page shows,
   * and it differs between a staging bot and a production one. Absent means this deployment
   * has no bot, and the page offers nothing rather than a link to `t.me/undefined`.
   */
  TELEGRAM_BOT?: string;
}

/** The canonical hostname, from the environment rather than from the request (§14.1). */
export const siteHost = (env as unknown as HostEnv).SITE_HOST;

/**
 * The origin used in absolute URLs — canonical links, Open Graph, JSON-LD.
 *
 * Built from configuration and never from the `Host` header. A header-derived origin is
 * how an attacker turns a canonical tag into a link to their own copy of the page.
 */
export const siteOrigin = siteHost === "localhost" ? "http://localhost:4321" : `https://${siteHost}`;

/**
 * The sibling surfaces, derived from this one (SPEC §14.3, ADR 0003).
 *
 * Derived rather than configured, and derived rather than written down. `/llms.txt` and
 * `/robots.txt` named `api.orator.space` and `mcp.orator.space` as literals, so staging
 * published the production addresses — telling every model that read it to go and act on
 * the live system while looking at test data.
 *
 * The shape is ADR 0003's: staging is `api-staging.orator.space` rather than
 * `api.staging.orator.space`, because Universal SSL covers the apex and one level of
 * subdomain and a second level would attach as a route and then fail TLS. So an environment
 * label in front becomes a suffix behind: `staging.orator.space` → `api-staging.orator.space`,
 * and a bare apex stays a bare prefix.
 */
function siblingOrigin(label: "api" | "mcp" | "media"): string {
  // In development both surfaces are the same Worker on one port, routed by nothing.
  if (siteHost === "localhost") return "http://localhost:8787";
  const parts = siteHost.split(".");
  // More than two labels means the first one names the environment.
  const [environment, ...apex] = parts.length > 2 ? parts : [null, ...parts];
  return environment === null
    ? `https://${label}.${apex.join(".")}`
    : `https://${label}-${environment}.${apex.join(".")}`;
}

export const apiOrigin = siblingOrigin("api");
export const mcpOrigin = siblingOrigin("mcp");

/**
 * SPEC §57.4 — where user bytes are served from, and never from here.
 *
 * Derived like its siblings rather than written down, for the reason `/llms.txt` learned the
 * hard way: a literal in the code makes staging publish production's addresses. The same
 * literal in §57.2's `img-src` made staging *forbid* its own pictures — the browser fetched
 * an avatar from `media-staging` against a policy naming `media.orator.space` and blocked it,
 * which looks from the account page exactly like an upload that failed.
 */
export const mediaOrigin = siblingOrigin("media");

/**
 * SPEC §50.1 — the preview shown for a page with no image of its own.
 *
 * A static asset rather than a generated one. Every social client crops to 1200×630 and
 * caches what it fetched, so this is read far more often than anything on the site and never
 * changes; generating it per request would be work done for a picture that is the same
 * picture. It lives in `public/` and is checked in, which also means a review sees it.
 */
export const defaultCard = `${siteOrigin}/card.png`;

/**
 * The documentation site (ADR 0013), and the one origin here that is *not* derived.
 *
 * Every sibling above is computed from `SITE_HOST` because a literal made staging publish
 * production's addresses. This one is a literal on purpose, and the difference is not
 * carelessness: there is exactly one documentation deployment. It has no staging counterpart
 * to derive, and `docs-staging.orator.space` does not exist — so deriving it would produce a
 * hostname that resolves to nothing, which is a worse failure than pointing staging at the
 * documentation it is in fact documented by.
 *
 * The same asymmetry is already in the error contract: `packages/protocol` mints every
 * problem `type` as `https://orator.space/errors/…` on both deployments, because a type URI
 * is an identifier rather than a location.
 */
export const docsOrigin = "https://docs.orator.space";

/**
 * Whether this deployment is the one that may appear in a search index (SPEC §50.2, §14.1).
 *
 * Exactly one of them is. Staging serves the same pages from the same zone under a different
 * hostname, which is the duplicate content §50.2 spends a section on — and the copy has no
 * `canonical_url` pointing anywhere, because §15.1's rule is about an article published on
 * two domains, not about a deployment accidentally published twice. Until 2026-09-05 nothing
 * distinguished them: `robots.txt` said `Allow: /` on both and no page carried `noindex`, so
 * the only thing keeping staging out of an index was that nobody had ever linked it.
 *
 * That is not a property to rely on — a link in a chat, an issue or an announcement is enough
 * — and it is worth nothing against a crawler that discovers hostnames from certificate
 * transparency logs, which every public certificate is published to.
 *
 * Local is not production either, and gets the same treatment for free. Nothing crawls
 * localhost; the value of that is that a developer sees on their own machine what staging
 * serves, rather than a behaviour that only exists on a deployment.
 */
export const indexableDeployment = (env as unknown as HostEnv).ENVIRONMENT === "production";

/** SPEC §9.3 — the bot's public name, or null where this deployment has none. */
export const telegramBot: string | null = (env as unknown as HostEnv).TELEGRAM_BOT ?? null;

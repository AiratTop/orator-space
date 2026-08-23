import { env } from "cloudflare:workers";
import {
  createR2AssetStore,
  createR2ContentStore,
  createReadingRepo,
  createSearchIndex,
} from "@orator/adapters-cf";
import type { ReadingPorts, SearchPorts } from "@orator/core";

/**
 * The ports the public web is allowed to reach (SPEC §28, §49).
 *
 * Four, not twenty-four. `ReadingPorts` is a read-only slice of `Ports`, so this surface
 * cannot issue a token, enqueue an event or write a revision — not by convention but
 * because there is nothing here to do it with. The two that were added since are narrowed
 * the same way: the asset store is `{ get }` and the search index is `{ query }`, so neither
 * can write. Anyone adding a write to a page has to come here first, which is the point at
 * which the question gets asked out loud.
 */
interface WebEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
  ASSETS_BUCKET: R2Bucket;
  ENVIRONMENT: string;
  SITE_HOST: string;
  /** SPEC §59.1 — flood protection for the one public read the edge cache cannot absorb. */
  FLOOD_SEARCH: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

const web = env as unknown as WebEnv;

export const ports: ReadingPorts = {
  reading: createReadingRepo(web.DB),
  content: createR2ContentStore(web.CONTENT),
};

/**
 * Reading, plus the ability to *ask* the search index a question (SPEC §38, §28).
 *
 * `query` and nothing else. `SearchIndex` also has `index` and `remove`, which belong to the
 * queue consumer that keeps the index in step with the data (§38.1); handing them to the
 * surface that renders untrusted content and relying on nobody calling them is the kind of
 * restriction that holds until it does not. `SearchPorts` narrows the parameter instead, so
 * this object is the whole of what a page can reach.
 */
export const searchPorts: SearchPorts = {
  ...ports,
  search: { query: createSearchIndex(web.DB).query },
};

/**
 * SPEC §59.1 — the one public page that cannot be answered from the edge cache.
 *
 * Every other read here is an address a cache can hold: an article, a feed page, a policy.
 * A search is an arbitrary string, so the cache absorbs a repeat and nothing else, and the
 * work behind it is an FTS query plus a row read per result. §59.2 already gives the REST
 * surface a tenth of the general allowance for exactly this; the HTML surface doing the same
 * work under no limit at all would be an inconsistency with a bill attached.
 */
export const searchLimiter = web.FLOOD_SEARCH;

/**
 * The generated files, read-only (SPEC §51).
 *
 * Deliberately not part of `ports`: the sitemap is built by the edge worker's cron, and the
 * apex only serves what is already there. Handing the public web a writable asset store
 * would put a way to publish a file into the surface that renders untrusted content.
 */
export const assets = { get: createR2AssetStore(web.ASSETS_BUCKET).get };

/** The canonical hostname, from the environment rather than from the request (§14.1). */
export const siteHost = web.SITE_HOST;
export const environment = web.ENVIRONMENT;

/**
 * The origin used in absolute URLs — canonical links, Open Graph, JSON-LD.
 *
 * Built from configuration and never from the `Host` header. A header-derived origin is
 * how an attacker turns a canonical tag into a link to their own copy of the page.
 */
export const siteOrigin =
  siteHost === "localhost" ? "http://localhost:4321" : `https://${siteHost}`;

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
function siblingOrigin(label: "api" | "mcp"): string {
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

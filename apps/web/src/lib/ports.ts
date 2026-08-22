import { env } from "cloudflare:workers";
import { createR2ContentStore, createReadingRepo } from "@orator/adapters-cf";
import type { ReadingPorts } from "@orator/core";

/**
 * The ports the public web is allowed to reach (SPEC §28, §49).
 *
 * Two, not thirteen. `ReadingPorts` is a read-only slice of `Ports`, so this surface
 * cannot issue a token, enqueue an event or write a revision — not by convention but
 * because there is nothing here to do it with. Anyone adding a write to a page has to
 * come here first, which is the point at which the question gets asked out loud.
 */
interface WebEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
  ENVIRONMENT: string;
  SITE_HOST: string;
}

const web = env as unknown as WebEnv;

export const ports: ReadingPorts = {
  reading: createReadingRepo(web.DB),
  content: createR2ContentStore(web.CONTENT),
};

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

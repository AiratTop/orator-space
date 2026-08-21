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

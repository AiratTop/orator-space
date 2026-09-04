import { env } from "cloudflare:workers";
import {
  createD1Database,
  createR2AssetStore,
  createR2ContentStore,
  createReadingRepo,
  createSearchIndex,
  createVectorIndex,
  createWorkersAiEmbedder,
  systemClock,
  createReadingListRepo,
  createTopicRepo,
} from "@orator/adapters-cf";
import type { ReadingListPorts, ReadingPorts, SearchPorts, TopicPorts } from "@orator/core";

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
  /** SPEC §61.2 — the one public *write* that takes no credential at all. */
  FLOOD_REPORT: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /**
   * SPEC §38.2, ADR 0012 — the two bindings semantic search needs, or neither.
   *
   * The only model this surface reaches, and it reaches it read-only in the strongest sense:
   * it turns a query into a vector and can do nothing else with either. §43.4 requires REST,
   * MCP and the web to reach the same verdict; a search is a read, so the same rule decides
   * what each of them is able to *find*, and a reader searching in one language for an
   * article written in another gets the answer an agent would.
   */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  VECTORS?: {
    upsert(vectors: { id: string; values: number[] }[]): Promise<unknown>;
    deleteByIds(ids: string[]): Promise<unknown>;
    query(
      vector: number[],
      options: { topK: number; returnValues?: boolean; returnMetadata?: "none" | "indexed" | "all" },
    ): Promise<{ matches: { id: string; score: number }[] }>;
  };
}

const web = env as unknown as WebEnv;

export const ports: ReadingPorts = {
  reading: createReadingRepo(web.DB),
  content: createR2ContentStore(web.CONTENT),
};

/**
 * The semantic leg, narrowed to `nearest` (SPEC §38.2, §28, ADR 0012).
 *
 * `VectorIndex` also has `upsert` and `remove`, which belong to the queue consumer that keeps
 * the store in step with the data — and this is the surface that renders untrusted content.
 * The same argument `search` makes about `query`, applied to the store: what a page can reach
 * is what is written here, so a write from a page fails to compile rather than fails review.
 *
 * Undefined when either binding is absent, which is a deployment state rather than a fault:
 * the dev server has neither, and §38.2's degradation makes search lexical there.
 */
const semantic =
  web.AI === undefined || web.VECTORS === undefined
    ? undefined
    : {
        embedder: createWorkersAiEmbedder(web.AI),
        vectors: { nearest: createVectorIndex(web.VECTORS).nearest },
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
  ...(semantic === undefined ? {} : { semantic }),
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
 * SPEC §61.2 — reporting takes no account, so the address is all there is to limit by.
 *
 * §61.2 is explicit that requiring registration to report illegal content is not acceptable,
 * and equally explicit that an anonymous report is subject to the same per-address limit as
 * any other anonymous operation. The service already collapses a flood aimed at one target
 * (twenty an hour, then refusal); this bounds a flood aimed at *many* targets, which that
 * counter cannot see.
 */
export const reportLimiter = web.FLOOD_REPORT;

/**
 * Reading, plus the curated vocabulary (SPEC §22, §28).
 *
 * `TopicRepo` is read-only by construction — the vocabulary arrives by migration and
 * membership from the classifier, so there is nothing here to narrow further. It is a
 * separate object rather than an addition to `ports` for the same reason `searchPorts` is:
 * a page that does not render topics has no use for the repo, and the smallest set a page
 * can reach is the one it should be handed.
 */
export const topicPorts: TopicPorts = {
  ...ports,
  topics: createTopicRepo(web.DB),
};

/**
 * Reading, plus one person's own list (SPEC §49.2, ADR 0011).
 *
 * The only writable thing the public web reaches besides the account and comment surfaces,
 * and the narrowest of the three: it can add and remove a row that names an article and the
 * person who saved it. Nothing else in the system reads that table, which is what keeps ADR
 * 0011's refusal intact — a private list cannot become a public number if no aggregate
 * anywhere asks it a question.
 */
export const readingListPorts: ReadingListPorts = {
  ...ports,
  readingList: createReadingListRepo(web.DB),
  db: createD1Database(web.DB),
  clock: systemClock,
};

/**
 * The generated files, read-only (SPEC §51).
 *
 * Deliberately not part of `ports`: the sitemap is built by the edge worker's cron, and the
 * apex only serves what is already there. Handing the public web a writable asset store
 * would put a way to publish a file into the surface that renders untrusted content.
 */
export const assets = { get: createR2AssetStore(web.ASSETS_BUCKET).get };

/**
 * The addresses, re-exported from where they are defined (§14.1, §14.3, §57.4).
 *
 * They moved to `origins.ts` when the middleware needed one: a request for a static file
 * should not construct a database adapter to learn the media origin. Re-exported here rather
 * than left for every caller to re-import, because "where the site lives" and "what the site
 * may reach" are asked together on nearly every page.
 */
export {
  apiOrigin,
  defaultCard,
  docsOrigin,
  indexableDeployment,
  mcpOrigin,
  mediaOrigin,
  siteHost,
  siteOrigin,
} from "./origins.js";

export const environment = web.ENVIRONMENT;

/**
 * Ports — the only surface the domain exposes to infrastructure (SPEC §28).
 * Implementations live in @orator/adapters-cf; in-memory doubles back the domain tests.
 */
import type { OratorId } from "@orator/protocol";

/** Injected so the domain never reads the clock directly — makes time testable. */
export interface Clock {
  now(): Date;
}

/** SPEC §12 — monotonic UUIDv7 rendered as Crockford base32. */
export interface IdGen {
  next(): OratorId;
}

/**
 * SPEC §16.2 — revision bodies are content-addressed and live outside D1.
 * The domain never touches `content_ref` directly; it goes through here.
 */
export interface ContentStore {
  /** Returns the sha256 of the stored content; writing the same body twice is a no-op. */
  put(markdown: string): Promise<string>;
  get(contentHash: string): Promise<string | null>;
  /** SPEC §23.3 — refcount is checked by the caller before deletion. */
  delete(contentHash: string): Promise<void>;

  /**
   * SPEC §23.3, §32.2 — the same rule, in one round trip.
   *
   * Erasing an article with two hundred and fifty distinct bodies made two hundred and fifty
   * sequential calls to the store, inside a request somebody is waiting on. The refcount
   * check is still per hash and still the caller's; this is only the deleting.
   */
  deleteMany(contentHashes: readonly string[]): Promise<void>;

  /**
   * SPEC §32.2 — what is actually in the store, a page at a time.
   *
   * The collector reads this rather than asking the database which hashes look unreferenced,
   * and the difference is two whole classes of bug. A query over `revisions` cannot see an
   * object whose row never committed — there is no `content_hash` to group by — so a body
   * written before a failed commit was invisible to collection forever, which for text
   * containing personal data means it is stored with no entity through which anyone could
   * demand its erasure. And a query answers the same rows every time: a collector that
   * deletes them makes no progress it can observe, re-reads the same first hundred on the
   * next pass, and never reaches the rest.
   *
   * Listing the store fixes both, because deleting an object removes it from the listing.
   * Progress is the absence of what was collected.
   *
   * `uploadedAt` is the object's own timestamp, which the grace period needs: §16.2 writes
   * the object before the revision row, so a body seconds old may be one whose row is still
   * on its way.
   */
  list(options: { cursor?: string | null; limit: number }): Promise<{
    objects: { contentHash: string; uploadedAt: string }[];
    cursor: string | null;
  }>;
  /**
   * The opaque `content_ref` stored on a revision. Only the adapter knows its shape, so
   * moving content elsewhere later changes one implementation rather than the domain.
   */
  refFor(contentHash: string): string;
}

/** SPEC §35 — appended inside the same batch as the domain write, never separately. */
export interface OutboxEvent {
  type: string;
  aggregateType: string;
  aggregateId: OratorId;
  payload: Record<string, unknown> & { schema_version: number };
}

export * from "./database.js";
export * from "./repos.js";
export * from "./articles.js";
export * from "./metrics.js";
export * from "./quota.js";
export * from "./reading.js";
export * from "./social.js";
export * from "./search.js";
export * from "./vectors.js";
export * from "./classifier.js";
export * from "./transform.js";
export * from "./reading-list.js";
export * from "./topics.js";
export * from "./media.js";
export * from "./moderation.js";
export * from "./passkeys.js";
export * from "./sitemap.js";
export * from "./slo.js";
export * from "./telegram.js";

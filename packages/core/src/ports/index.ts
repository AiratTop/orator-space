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
export * from "./topics.js";
export * from "./media.js";
export * from "./moderation.js";
export * from "./passkeys.js";
export * from "./sitemap.js";

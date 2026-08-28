import type { OratorId } from "@orator/protocol";
import type { MediaKind } from "../media/sniff.js";
import type { PendingWrite } from "./database.js";

/** SPEC §21 — the record is metadata; the bytes live in object storage. */

export type MediaStatus = "pending" | "ready" | "rejected" | "removed";
export type MediaSource = "upload" | "generated";

export interface MediaRecord {
  id: OratorId;
  ownerPrincipalId: OratorId;
  status: MediaStatus;
  kind: MediaKind;
  storageKey: string | null;
  contentType: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  altText: string | null;
  source: MediaSource;
  generationMetadata: Record<string, unknown> | null;
  createdAt: string;
  finalizedAt: string | null;
}

export interface NewMedia {
  id: OratorId;
  ownerPrincipalId: OratorId;
  kind: MediaKind;
  altText: string | null;
  source: MediaSource;
  generationMetadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface StoredMedia {
  storageKey: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
  finalizedAt: string;
}

export interface MediaRepo {
  findById(id: string): Promise<MediaRecord | null>;
  insert(media: NewMedia): PendingWrite;
  /**
   * Conditional on the record still being `pending`, so two uploads racing the same
   * record cannot both succeed. The row count is the answer (§34.3).
   */
  markReady(id: string, stored: StoredMedia): PendingWrite;
  markRejected(id: string, at: string): PendingWrite;
  /**
   * SPEC §23.4, §23.4 — `pending` rows with no bytes, after twenty-four hours.
   *
   * §21.1 makes the upload a second call, so a caller that creates a record and never sends
   * anything leaves a row pointing at nothing. Returns the ids rather than a count: each one
   * may have a partial object in R2 that has to go with it, and the caller is the only thing
   * that can reach the bucket.
   */
  listStalePending(cutoff: string, limit: number): Promise<string[]>;
  deleteRecords(ids: readonly string[]): PendingWrite;
}

/** What a stream turned out to contain, once it had all gone past. */
export interface UploadOutcome {
  byteSize: number;
  sha256: string;
  /** The first bytes, kept for sniffing. Never more than `SNIFF_BYTES`. */
  leading: Uint8Array;
}

/**
 * SPEC §21.1 — media bytes, written in one streamed pass.
 *
 * `declaredLength` is not advisory. The adapter writes through a fixed-length stream, so a
 * body that does not match it fails rather than being stored: the length the caller
 * promised and the length enforced are the same number, and neither the domain nor the
 * adapter has to trust the other about it.
 */
export interface MediaStore {
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    declaredLength: number,
  ): Promise<UploadOutcome>;
  /**
   * Writes a derived object — a variant (§21.2) — with no declared length.
   *
   * Separate from `put` because the check `put` makes does not apply here. That check exists
   * because an upload is untrusted: §21.1 counts the bytes as they stream and refuses a body
   * that disagrees with what its sender promised. A variant has no sender and no promise —
   * it is produced by the platform from bytes this system already accepted — so there is
   * nothing to hold to a declaration, and demanding one would mean buffering the result
   * purely to measure it.
   */
  putDerived(key: string, body: ReadableStream<Uint8Array>): Promise<void>;
  /** Null when the object is absent. The caller decides whether that is an error. */
  get(key: string): Promise<MediaBody | null>;
  delete(key: string): Promise<void>;
}

export interface MediaBody {
  body: ReadableStream<Uint8Array>;
  byteSize: number;
  etag: string;
}

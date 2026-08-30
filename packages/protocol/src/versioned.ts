import { SCHEMA_VERSION } from "./version.js";

/**
 * The codec for a versioned JSON blob (SPEC §46.4).
 *
 * "Every JSON blob in the database carries `schema_version`. Reading without regard for the
 * version is forbidden." Both halves were being done by hand at every call site, and by hand
 * is how each of them came apart:
 *
 *   - `{ schema_version: SCHEMA_VERSION, ...input.metadata }` puts the caller's object last,
 *     so a client sending `"schema_version": 99` — or `"schema_version": "banana"` — decides
 *     what version the row claims to be. The one field a migration must be able to trust is
 *     the one field the untrusted half could set.
 *   - `media.generation_metadata` was written with no version at all, which §46.4 names
 *     explicitly as one of the three blobs that must carry one.
 *   - every read was a bare `JSON.parse`, which is the "without regard for the version" the
 *     same paragraph forbids.
 *
 * So: `versioned()` writes, `readVersioned()` reads, and the version is the codec's field
 * rather than a key in a record anybody may write.
 */
export type Versioned<T> = T & { schema_version: number };

/**
 * Stamps the current version on a blob, last, so nothing in `value` can displace it.
 *
 * The key is dropped from the caller's object rather than merged around: a caller that sent
 * one meant something by it, and silently keeping a number the platform did not write would
 * make the field mean two things.
 */
export function versioned<T extends Record<string, unknown>>(value: T): Versioned<T> {
  const { schema_version: _ignored, ...rest } = value;
  return { ...(rest as T), schema_version: SCHEMA_VERSION };
}

/**
 * Parses a stored blob and hands back its version along with it.
 *
 * A blob written before anything stamped one reads as version `0` — a fact, and one a
 * migration can branch on, rather than an absence each reader rediscovers. A version this
 * build does not know throws: §65 ships a reader before the writer that produces it, so a
 * number from the future means the release order was broken, and guessing at the shape is
 * how that becomes a data migration instead of an error.
 */
export function readVersioned(json: string | null | undefined): Versioned<Record<string, unknown>> | null {
  if (json === null || json === undefined) return null;
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const declared = parsed["schema_version"];
  const version = typeof declared === "number" && Number.isInteger(declared) ? declared : 0;
  if (version > SCHEMA_VERSION) {
    throw new RangeError(`schema_version ${version} is newer than this build reads (${SCHEMA_VERSION})`);
  }
  return { ...parsed, schema_version: version };
}

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
 * Four cases, and they are deliberately not three. The first version of this collapsed every
 * unusable version onto `0` — `"banana"`, `null`, `-1` all read as "written before we
 * stamped versions" — which is the one answer that is certainly wrong: absence is a fact
 * about an old row, and a present-but-nonsense value is a fact about a corrupt one. A reader
 * that cannot tell them apart will migrate the corrupt row as though it were legacy.
 *
 *   absent            legacy, version 0. §46.4 arrived after some rows did
 *   present, unusable throws. Not a number, not an integer, or negative
 *   known             read it
 *   newer than this   throws. §65 ships a reader before the writer that produces it, so a
 *                     number from the future means the release order was broken, and
 *                     guessing at the shape is how that becomes a data migration
 *
 * The root has to be an object, too. `JSON.parse` is happy to return `[]`, `null` or `7`,
 * and every caller here spreads the result into a record — a blob holding `null` would have
 * become `{ schema_version: 0 }` and read as an empty legacy object rather than as the
 * damage it is.
 */
export function readVersioned(json: string | null | undefined): Versioned<Record<string, unknown>> | null {
  if (json === null || json === undefined) return null;

  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`a versioned blob is a JSON object, not ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}`);
  }

  const record = parsed as Record<string, unknown>;
  if (!Object.hasOwn(record, "schema_version")) return { ...record, schema_version: 0 };

  const declared = record["schema_version"];
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 0) {
    throw new TypeError(`schema_version is not a version: ${JSON.stringify(declared)}`);
  }
  if (declared > SCHEMA_VERSION) {
    throw new RangeError(`schema_version ${declared} is newer than this build reads (${SCHEMA_VERSION})`);
  }
  return { ...record, schema_version: declared };
}

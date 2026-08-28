import { SNIFF_BYTES } from "@orator/core";
import type { MediaBody, MediaStore, UploadOutcome } from "@orator/core/ports";

/**
 * Media bytes in R2, written in one streamed pass (SPEC §21.1, ADR 0005).
 *
 * The three facts the domain needs about a file — how long it is, what it hashes to, and
 * what its leading bytes say it is — are all collected while it goes past, because there
 * is no second chance to look: 50 MB does not sit in a Worker's memory alongside anything
 * else, and `crypto.subtle.digest` has no incremental form.
 */

/** Workers provides a streaming digest for exactly this; the Web Crypto API does not. */
interface DigestStreamCtor {
  new (algorithm: string): WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
}

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function createR2MediaStore(bucket: R2Bucket, prefix = "media/"): MediaStore {
  return {
    /**
     * SPEC §21.2 — a derived variant, written without the counted-upload machinery.
     *
     * No digest and no length check: those exist in `put` because an upload is untrusted and
     * its sender made a claim about it. This body came from the transformation of an object
     * this system already accepted, so there is no claim to check and nothing to hash for.
     *
     * **The prefix is not optional here, and leaving it off cost more than a misplaced file.**
     * Every other method applies it, so a variant written to the bare key was invisible to
     * `get`: the store answered "not produced yet", the transformation ran again, the object
     * was written again, and the caller fell back to the original. One picture, one billable
     * transformation per request, for as long as it was looked at — and an avatar that was
     * never once served at the size it was made for. The symptom is a correct picture at the
     * wrong size, which is exactly the failure §21.2's fallback was warned to hide.
     */
    async putDerived(key: string, body: ReadableStream<Uint8Array>): Promise<void> {
      await bucket.put(prefix + key, body);
    },

    async put(
      key: string,
      body: ReadableStream<Uint8Array>,
      declaredLength: number,
    ): Promise<UploadOutcome> {
      const { DigestStream } = crypto as unknown as { DigestStream: DigestStreamCtor };
      const digest = new DigestStream("SHA-256");
      const digestWriter = digest.getWriter();
      /**
       * Marked handled up front, and only then used.
       *
       * When the pipe tears, everything attached to it rejects at once — including these
       * two, which are not awaited on the failure path. A rejection nobody is listening to
       * is reported by workerd as an uncaught exception, and it arrives alongside the real
       * error looking exactly as serious.
       */
      const digested = digest.digest;
      void digested.catch(() => undefined);
      void digestWriter.closed.catch(() => undefined);

      let byteSize = 0;
      const leading = new Uint8Array(SNIFF_BYTES);
      let captured = 0;

      const inspect = new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          byteSize += chunk.byteLength;
          /**
           * Stopped here rather than downstream.
           *
           * `FixedLengthStream` would refuse the surplus anyway, but it refuses with a
           * platform `TypeError` about byte counts, some way from anything the caller did.
           * Failing at the chunk that goes over says what happened in the words the API
           * uses, and stops reading a body that has already disqualified itself.
           */
          if (byteSize > declaredLength) {
            throw new Error(`body is longer than the declared ${declaredLength} bytes`);
          }
          if (captured < SNIFF_BYTES) {
            const take = chunk.subarray(0, SNIFF_BYTES - captured);
            leading.set(take, captured);
            captured += take.byteLength;
          }
          await digestWriter.write(chunk);
          controller.enqueue(chunk);
        },
        async flush() {
          await digestWriter.close();
        },
      });

      /**
       * Not a workaround — the only shape R2 accepts, and the enforcement as well.
       *
       * `put()` refuses a stream of unknown length, and a `tee()` branch is one, which is
       * how the first draft of this failed. Building the stream from the declared length
       * means a body that runs short or long tears here instead of being stored, so the
       * length the caller promised and the length written are the same number by
       * construction rather than by a check somebody has to remember.
       */
      const fixed = new FixedLengthStream(declaredLength);
      /**
       * Two explicit pipes rather than `pipeThrough`.
       *
       * `pipeThrough` starts the first pipe and hands back only the readable end, so the
       * promise for `body → inspect` belongs to nobody. When the write fails that promise
       * rejects unobserved, and workerd reports it as an uncaught exception next to the
       * error that actually caused it.
       */
      const feeding = body.pipeTo(inspect.writable);
      const pumped = inspect.readable.pipeTo(fixed.writable);
      const written = bucket.put(prefix + key, fixed.readable);

      /**
       * Both are awaited, whichever fails.
       *
       * A mismatched length tears the pipe and aborts the write, so the two reject
       * together. Awaiting them in sequence leaves the loser rejecting with nobody
       * listening, which workerd reports as an unhandled rejection — noise in the log at
       * best, and at worst the real cause buried under it.
       */
      const outcomes = await Promise.allSettled([feeding, pumped, written]);
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed !== undefined) {
        await digestWriter.abort(failed.reason).catch(() => undefined);
        throw failed.reason;
      }

      return { byteSize, sha256: hex(await digested), leading: leading.subarray(0, captured) };
    },

    async get(key: string): Promise<MediaBody | null> {
      const object = await bucket.get(prefix + key);
      if (object === null) return null;
      return { body: object.body, byteSize: object.size, etag: object.httpEtag };
    },

    async delete(key: string): Promise<void> {
      await bucket.delete(prefix + key);
    },
  };
}

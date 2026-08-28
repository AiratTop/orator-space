import { VARIANT_SPEC, type MediaTransform, type TransformedImage, type Variant } from "@orator/core/ports";

/**
 * Variants over Cloudflare's Images binding (SPEC §21.2).
 *
 * §21.2 rules out doing this in a Worker directly — CPU and memory limits (§40) — and this is
 * the platform implementation it points at. The binding runs the transformation outside the
 * Worker's own budget and hands back a stream.
 *
 * **WebP, and one format for every variant.** A per-request `Accept` negotiation would double
 * the number of stored objects and, worse, make the stored object depend on who asked for it
 * first — §21.2's whole argument is that the number of distinct transformations is bounded and
 * knowable. WebP is supported everywhere that matters and is smaller than JPEG at the same
 * quality; a client that cannot read it is a client that cannot read the site's CSS either.
 */
interface ImagesBinding {
  input(stream: ReadableStream<Uint8Array>): {
    transform(options: Record<string, unknown>): {
      output(options: Record<string, unknown>): Promise<{ image(): ReadableStream<Uint8Array> }>;
    };
  };
}

const OUTPUT_TYPE = "image/webp";

export function createImageTransform(images: ImagesBinding | undefined): MediaTransform {
  return {
    async produce(source, variant: Exclude<Variant, "original">, contentType) {
      /*
       * No binding is a deployment without the product, not a failure.
       *
       * The local dev server and the `workerd` tests have none — Images has no simulator —
       * and §21.2's rule covers it: the caller falls back to the original. That is the same
       * degradation an outage produces, which is the point of having only one.
       */
      if (images === undefined) return null;

      // Not an image is not something to resize. A PDF or a video reaching here is a caller
      // asking for a variant of something that has none, and the original is the answer.
      if (!contentType.startsWith("image/")) return null;

      const spec = VARIANT_SPEC[variant];

      try {
        const result = await images
          .input(source)
          .transform({
            width: spec.width,
            ...(spec.height === undefined ? {} : { height: spec.height }),
            fit: spec.fit,
          })
          .output({ format: OUTPUT_TYPE });

        return { body: result.image(), contentType: OUTPUT_TYPE } satisfies TransformedImage;
      } catch (error) {
        /*
         * Logged and null. §21.2 requires the fallback rather than the failure, and the log is
         * what keeps "quietly serving originals forever" from being indistinguishable from
         * working — the bytes are right and the bill and the page weight are not.
         */
        console.error(
          JSON.stringify({
            level: "error",
            event: "images.transform.failed",
            variant,
            content_type: contentType,
            error: String(error),
          }),
        );
        return null;
      }
    },
  };
}

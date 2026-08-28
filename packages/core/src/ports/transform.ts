/**
 * Named image variants (SPEC §21.2, §50.1).
 *
 * §21.2 forbids an in-house resize pipeline in a Worker — CPU and memory limits (§40) make it
 * the wrong place — and puts variant generation behind this port so that the platform doing
 * the work is a deployment detail rather than a domain one.
 *
 * The set is closed and the port takes a name, never a size. A URL carrying width and height
 * is an open invitation: transformations are billed per unique transformation, so an address
 * accepting arbitrary numbers lets any caller mint unlimited billable variants of one image.
 * A name maps to one transformation and no more exist than are declared here.
 */

export const VARIANTS = ["avatar", "card", "hero", "social", "original"] as const;
export type Variant = (typeof VARIANTS)[number];

export const isVariant = (value: string): value is Variant =>
  (VARIANTS as readonly string[]).includes(value);

/**
 * What each name means, in one place.
 *
 * Here rather than in the adapter because these numbers are a product decision — what an
 * avatar is, how wide an article body renders — and an adapter is where the next platform
 * gets written. `original` is absent: it is the only one that is not a transformation.
 */
export const VARIANT_SPEC: Record<Exclude<Variant, "original">, {
  width: number;
  height?: number;
  fit: "cover" | "scale-down";
}> = {
  /** Square, small: a profile header and a byline (§49.4). */
  avatar: { width: 128, height: 128, fit: "cover" },
  /** The feed's thumbnail. Wider than tall, because a card is a row. */
  card: { width: 480, fit: "scale-down" },
  /** The widest an article body renders (§49.5's reading measure, at 2× for density). */
  hero: { width: 1280, fit: "scale-down" },
  /**
   * The Open Graph and Twitter preview (§50.1).
   *
   * 1200×630 is what every client crops to, and `cover` rather than `scale-down` because a
   * preview with letterboxing is the grey rectangle §50.1 exists to avoid, wearing a picture.
   */
  social: { width: 1200, height: 630, fit: "cover" },
};

export interface TransformedImage {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

export interface MediaTransform {
  /**
   * Produces one named variant, or null.
   *
   * Null rather than a throw, because §21.2 requires a variant that cannot be produced to fall
   * back to the original rather than to fail: an image is decoration on a page whose subject
   * is text (§2), and a resize service having a bad minute is not a reason for an article not
   * to render. A caller that has to remember to catch is a caller that will forget once.
   */
  produce(
    source: ReadableStream<Uint8Array>,
    variant: Exclude<Variant, "original">,
    contentType: string,
  ): Promise<TransformedImage | null>;
}

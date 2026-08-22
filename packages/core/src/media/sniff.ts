/**
 * What a file actually is, decided from its leading bytes (SPEC §21.1, §57.4).
 *
 * The client's `Content-Type` is a claim, not evidence. It is the difference between a
 * browser rendering an image and a browser executing a document, and the party that sets
 * it is the party with the incentive to lie about it — so it is recorded and then ignored.
 *
 * Deliberately a short allow-list rather than a long detector. Everything not on it is
 * refused, which means a format nobody thought about is refused too. A deny-list has the
 * opposite failure: the thing nobody thought about gets through.
 */

export type MediaKind = "image" | "video" | "audio" | "document";

export interface MediaType {
  contentType: string;
  kind: MediaKind;
  /**
   * Whether a browser may render it inline. Everything else is served as an attachment
   * (§57.4) — a download is inert, a rendered document is not.
   */
  displayable: boolean;
}

/** How many leading bytes a caller must capture for `sniff` to have anything to work with. */
export const SNIFF_BYTES = 64;

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

interface Signature {
  type: MediaType;
  /** Byte values at fixed offsets; `null` matches any byte, for embedded length fields. */
  at: readonly (readonly [number, readonly (number | null)[]])[];
}

const image = (contentType: string): MediaType => ({ contentType, kind: "image", displayable: true });

const SIGNATURES: readonly Signature[] = [
  { type: image("image/png"), at: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]] },
  { type: image("image/jpeg"), at: [[0, [0xff, 0xd8, 0xff]]] },
  { type: image("image/gif"), at: [[0, ascii("GIF8")]] },
  // RIFF container: "RIFF" then four bytes of length then the form type.
  { type: image("image/webp"), at: [[0, ascii("RIFF")], [8, ascii("WEBP")]] },
  // ISO-BMFF: a box length, then "ftyp", then the brand.
  { type: image("image/avif"), at: [[4, ascii("ftyp")], [8, ascii("avif")]] },
  { type: image("image/avif"), at: [[4, ascii("ftyp")], [8, ascii("avis")]] },
  {
    type: { contentType: "application/pdf", kind: "document", displayable: false },
    at: [[0, ascii("%PDF-")]],
  },
  {
    type: { contentType: "video/mp4", kind: "video", displayable: true },
    at: [[4, ascii("ftyp")], [8, ascii("isom")]],
  },
  {
    type: { contentType: "video/mp4", kind: "video", displayable: true },
    at: [[4, ascii("ftyp")], [8, ascii("mp42")]],
  },
  {
    type: { contentType: "video/webm", kind: "video", displayable: true },
    at: [[0, [0x1a, 0x45, 0xdf, 0xa3]]],
  },
  {
    type: { contentType: "audio/mpeg", kind: "audio", displayable: true },
    at: [[0, ascii("ID3")]],
  },
  {
    type: { contentType: "audio/mpeg", kind: "audio", displayable: true },
    at: [[0, [0xff, null]]],
  },
  {
    type: { contentType: "audio/ogg", kind: "audio", displayable: true },
    at: [[0, ascii("OggS")]],
  },
  {
    type: { contentType: "audio/wav", kind: "audio", displayable: true },
    at: [[0, ascii("RIFF")], [8, ascii("WAVE")]],
  },
];

const matches = (bytes: Uint8Array, signature: Signature): boolean =>
  signature.at.every(([offset, pattern]) =>
    pattern.every((expected, i) => expected === null || bytes[offset + i] === expected),
  );

/**
 * The type of these bytes, or null if it is not one Orator accepts.
 *
 * An `audio/mpeg` frame header is `0xFF` followed by a byte whose top three bits are set,
 * which is thin as signatures go — thin enough that it is checked last, after every
 * container format, so nothing else can be swallowed by it.
 */
export function sniff(leading: Uint8Array): MediaType | null {
  for (const signature of SIGNATURES) {
    if (!matches(leading, signature)) continue;
    // The loose MPEG frame check: confirm the sync word properly rather than on 0xFF alone.
    if (signature.type.contentType === "audio/mpeg" && leading[0] === 0xff) {
      if (((leading[1] ?? 0) & 0xe0) !== 0xe0) continue;
    }
    return signature.type;
  }
  return null;
}

/**
 * SVG and XML-based formats are refused outright rather than sanitised (ADR 0005).
 *
 * Detected separately from the allow-list so the refusal can say what it refused. "SVG is
 * not accepted" is actionable; "unrecognised file type" sends the caller to look for a
 * corrupt upload that is not there.
 */
export function looksLikeXml(leading: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })
    .decode(leading)
    .trimStart()
    .toLowerCase();
  return head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!doctype");
}

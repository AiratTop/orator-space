/**
 * In `text/` rather than under `articles/`, and the module seal is what said so.
 *
 * This is a fact about Unicode, not about articles. Rendering strips these characters
 * (§57.1) and moderation reports them (§58.2), and those are two domain modules that may
 * not import each other — correctly, because a rule one of them owned would be a rule the
 * other reached across a boundary to reuse. Two lists maintained separately would drift,
 * leaving a character the renderer removes and the scanner does not know to report, which
 * is exactly the gap §58.2 calls the primary delivery mechanism.
 */

/**
 * Removal of invisible characters (SPEC §58.2).
 *
 * Hidden text is the primary delivery mechanism for prompt injection: a payload a human
 * reviewer cannot see, sitting in the same bytes an agent feeds straight into its context.
 * §58.2 makes carrying it a MUST NOT, and §57.1 places the work at render time so the
 * stored markdown stays exactly what the author sent.
 *
 * Applied to every representation an agent can read — the rendered page and the `.md`
 * source alike — because the `.md` path is the one agents actually consume.
 */

/**
 * Characters with no legitimate role in prose, removed outright.
 *
 *   00AD          soft hyphen — a hyphenation hint, invisible, and a free payload channel
 *   180E          Mongolian vowel separator — reclassified as a format character
 *   200B          zero-width space
 *   200E 200F     LRM / RLM
 *   202A-202E     bidi embedding and override — the Trojan Source vector
 *   2060-2064     word joiner and the invisible math operators
 *   2066-2069     bidi isolates
 *   FEFF          byte order mark appearing mid-document
 *   115F 1160 3164 FFA0   Hangul fillers — render as nothing, count as letters
 *   E0000-E007F   Unicode Tags — an entire ASCII alphabet that renders as zero pixels
 *   E0100-E01EF   variation selectors supplement — the same trick, one plane up
 *
 * Deliberately absent: FE00-FE0F. Those variation selectors carry emoji presentation, and
 * removing them changes what a reader sees.
 */
const INVISIBLE =
  /[\u00AD\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u115F\u1160\u3164\uFFA0]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

/**
 * ZWJ and ZWNJ are handled separately, and not by removal.
 *
 * A blanket strip would be the safer-looking rule and the wrong one: it breaks Persian and
 * Indic orthography and shatters emoji sequences, damaging real content on every page to
 * close a channel worth a few bits per character. What never occurs in real text is two of
 * them in a row — a family emoji separates its joiners with emoji — so runs collapse to
 * their first character and the smuggling capacity goes with them.
 */
const JOINER_RUN = /[\u200C\u200D]{2,}/gu;

/** Control characters. Rejected on write (§44.2); stripped here for the existing archive. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * How many invisible characters the text carries (SPEC §58.2).
 *
 * Here rather than in the moderation provider because this module owns the definition of
 * "invisible", and a second list maintained beside it would drift — leaving a character the
 * renderer strips and the scanner does not know to report, which is the exact gap §58.2
 * calls the primary delivery mechanism.
 *
 * Joiner runs count as one: a single ZWJ is ordinary in Persian, Indic scripts and emoji,
 * and only a run of them is a channel.
 */
export function countInvisible(text: string): number {
  const marks = text.match(new RegExp(INVISIBLE.source, "gu"))?.length ?? 0;
  const runs = text.match(new RegExp(JOINER_RUN.source, "gu"))?.length ?? 0;
  return marks + runs;
}

export function stripInvisible(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(JOINER_RUN, (run) => run[0]!)
    .replace(CONTROL, "");
}

/** True when stripping would change the text — a signal worth handing to moderation (§61). */
export const hasInvisible = (text: string): boolean => stripInvisible(text) !== text;

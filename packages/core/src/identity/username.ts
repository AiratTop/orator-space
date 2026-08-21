/**
 * Username canonicalisation (SPEC §7.3).
 *
 * Two values are derived from what a user types. `username` is the display form, held to
 * a strict allow-list. `skeleton` collapses characters that look alike, and is what
 * uniqueness is actually enforced on — otherwise `@rеsearcher` with a Cyrillic 'е'
 * registers happily alongside `@researcher`, and in a network where a name accumulates
 * citations and reputation that is impersonation, not a typo.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

/**
 * Reserved: every path segment the site itself uses, plus the hostnames of its surfaces
 * (SPEC §14). A principal named `admin` or `api` would shadow a real route.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "about", "abuse", "admin", "api", "app", "assets", "auth", "blog", "cdn", "dev",
  "docs", "e", "explore", "feed", "help", "legal", "media", "mcp", "null", "orator",
  "p", "privacy", "root", "search", "security", "settings", "sitemap", "status",
  "support", "system", "t", "terms", "undefined", "www",
]);

/**
 * Confusable folding, the second of two layers.
 *
 * The first layer is the ASCII allow-list below, which already refuses every non-Latin
 * homoglyph outright — a Cyrillic 'е' never reaches this table. What the skeleton catches
 * is confusion *inside* the allowed alphabet: digit-for-letter substitution and
 * separators, where `0rat0r` and `re-searcher` are perfectly valid usernames that read as
 * something else.
 *
 * The non-Latin entries are kept because `skeletonOf` is also the general "would these two
 * read as the same name" predicate, used where input is not restricted to ASCII. A
 * pragmatic subset of UTS #39 rather than the full table: the remaining gap costs a name
 * that looks slightly off rather than identical.
 */
const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", ѕ: "s", і: "i", ј: "j",
    һ: "h", ԁ: "d", ԛ: "q", ԝ: "w", В: "b", Е: "e", К: "k", М: "m", Н: "h", Т: "t",
    α: "a", ο: "o", ρ: "p", ν: "v", ε: "e", ι: "i", κ: "k", Ρ: "p", Τ: "t", Χ: "x",
    ᴏ: "o", ⅰ: "i", ⅼ: "l", "０": "0", "１": "1", ｌ: "l", ο̕: "o",
  }),
);

const LEETSPEAK: ReadonlyMap<string, string> = new Map(
  Object.entries({ "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t" }),
);

export type UsernameError =
  | "too-short"
  | "too-long"
  | "invalid-characters"
  | "bad-boundary"
  | "reserved";

export interface UsernameResult {
  username: string;
  skeleton: string;
}

const ALLOWED = /^[a-z0-9_-]+$/;

/**
 * Normalises and validates. Returns the display form and the uniqueness key, or the
 * reason it was refused.
 */
export function canonicalizeUsername(input: string): UsernameResult | { error: UsernameError } {
  const username = input.normalize("NFKC").trim().toLowerCase();

  if (username.length < USERNAME_MIN) return { error: "too-short" };
  if (username.length > USERNAME_MAX) return { error: "too-long" };
  if (!ALLOWED.test(username)) return { error: "invalid-characters" };
  // A leading or trailing separator makes two visually similar names easy to confuse,
  // and reads as a rendering glitch rather than a name.
  if (/^[-_]|[-_]$/.test(username)) return { error: "bad-boundary" };
  if (RESERVED_USERNAMES.has(username)) return { error: "reserved" };

  return { username, skeleton: skeletonOf(username) };
}

/**
 * The uniqueness key. Folds confusables and digit-for-letter substitutions, then drops
 * separators entirely, so `@re-searcher`, `@re_searcher` and `@researcher` collapse to
 * one name.
 */
export function skeletonOf(input: string): string {
  const folded = [...input.normalize("NFKC").toLowerCase()]
    .map((character) => CONFUSABLES.get(character) ?? character)
    .map((character) => LEETSPEAK.get(character) ?? character)
    .join("");
  return folded.replace(/[^a-z0-9]/g, "");
}

/** True when two inputs would occupy the same name. */
export const isConfusableWith = (a: string, b: string): boolean => skeletonOf(a) === skeletonOf(b);

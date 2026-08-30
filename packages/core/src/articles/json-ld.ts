/**
 * Serialising JSON-LD for an HTML `<script>` (SPEC §52, §57.1).
 *
 * `JSON.stringify` produces valid JSON, and valid JSON is not safe HTML. The HTML parser
 * ends a `<script>` element at the first `</script` in its text, before any JSON parser
 * sees the document, so a title containing that string closes the element and everything
 * after it is parsed as markup — inside `<head>`, where a `<meta http-equiv="refresh">`
 * needs no script to redirect a reader. The CSP bounds what an injected *script* can do
 * and says nothing at all about injected markup.
 *
 * Titles and excerpts are untrusted text (§57.1): anybody who can publish writes them. So
 * the serialiser escapes rather than the caller remembering to, and it escapes at the
 * point the string is produced instead of leaving a raw `JSON.stringify` anywhere a later
 * page could pick up.
 *
 * What is escaped, and why each one:
 *
 *   `<`  ends the element — `</script`, and `<!--`, which starts a comment state the
 *        parser does not leave at the next `</script`
 *   `>`  not dangerous alone; escaped so that no `-->` survives either
 *   `&`  never dangerous in a `<script>`, whose content is raw text and not entity-decoded.
 *        Escaped anyway, because it is what makes this function idempotent: nothing it
 *        emits contains a character it would escape a second time, so applying it twice —
 *        once here, once at the sink — is exactly applying it once.
 *   U+2028, U+2029  legal in JSON, and line terminators in JavaScript before ES2019. A
 *        document copied into a `<script>` of any other type breaks on them.
 *
 * The escapes are `\uXXXX` sequences, which JSON defines for any character in a string, so
 * the document a parser reads back is identical to the one that went in.
 */
export function jsonLdDocument(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

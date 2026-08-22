/**
 * Content rules for articles (SPEC §16, §44.2).
 *
 * Deliberately not sanitisation: that happens at render time, not at write time, so the
 * stored markdown stays exactly what the author sent and tightening the rules later can
 * be applied to the whole archive without a migration (§57.1).
 */

/** SPEC §44.2. Bodies live in R2, so the ceiling is about abuse, not storage. */
export const MAX_CONTENT_BYTES = 1024 * 1024;
export const MAX_TITLE_LENGTH = 300;
export const MIN_CONTENT_BYTES = 1;
const WORDS_PER_MINUTE = 220;

export type ContentError =
  | "title-empty"
  | "title-too-long"
  | "content-empty"
  | "content-too-large"
  | "control-characters";

// Control characters other than tab, newline and carriage return. They serve no purpose
// in markdown and are a cheap way to smuggle invisible payloads past a reader (§58.2).
// The rule below exists to catch these by accident; here they are the subject.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export interface ValidatedContent {
  title: string;
  content: string;
  contentBytes: number;
  readingTimeSeconds: number;
  excerpt: string;
}

export function validateContent(
  title: string,
  content: string,
): ValidatedContent | { error: ContentError } {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) return { error: "title-empty" };
  if (trimmedTitle.length > MAX_TITLE_LENGTH) return { error: "title-too-long" };
  if (FORBIDDEN_CONTROL.test(trimmedTitle) || FORBIDDEN_CONTROL.test(content)) {
    return { error: "control-characters" };
  }

  const contentBytes = new TextEncoder().encode(content).length;
  if (contentBytes < MIN_CONTENT_BYTES) return { error: "content-empty" };
  if (contentBytes > MAX_CONTENT_BYTES) return { error: "content-too-large" };

  return {
    title: trimmedTitle,
    content,
    contentBytes,
    readingTimeSeconds: readingTime(content),
    excerpt: deriveExcerpt(content),
  };
}

export function readingTime(markdown: string): number {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round((words / WORDS_PER_MINUTE) * 60));
}

/**
 * First substantial paragraph, flattened. Used for previews and social cards, so it must
 * not carry markup that would render as literal syntax outside a markdown context.
 */
export function deriveExcerpt(markdown: string, maxLength = 280): string {
  const paragraph = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith("#") && !block.startsWith("```"));
  if (paragraph === undefined) return "";

  const flattened = paragraph
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (flattened.length <= maxLength) return flattened;
  // Cut on a word boundary so the preview does not end mid-word.
  const cut = flattened.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}


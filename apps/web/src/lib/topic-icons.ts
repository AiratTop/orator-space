/**
 * A mark for each section of the vocabulary (SPEC §22.1, §49.5).
 *
 * **Here and not in the database.** The vocabulary is a curated, closed set — nine sections
 * and their leaves, written into migration 0011 — and which glyph stands for one is a
 * decision this application makes about how to draw it. An `icon` column would put a
 * presentation choice in the schema, where a second surface reading the same rows would have
 * to either honour it or contradict it (§28.1); the API returns topics and has no opinion
 * about pictures.
 *
 * **Sections only.** A leaf takes its section's mark, so `/t/inference` carries the same
 * glyph as `AI and machine learning` above it in the trail. Fifty marks would be fifty
 * decisions, most of them arbitrary, and the reader would learn none of them.
 *
 * **The fallback is the generic one.** §22.1 lets the vocabulary grow, and a section added to
 * it without a line here renders the layers mark rather than nothing — a row where some
 * headings carry a mark and some do not reads as a page that failed to load.
 */
const SECTION_ICON: Record<string, string> = {
  ai: "topic-ai",
  business: "topic-business",
  culture: "topic-culture",
  engineering: "topic-engineering",
  health: "topic-health",
  infrastructure: "topic-infrastructure",
  science: "topic-science",
  security: "topic-security",
  society: "topic-society",
};

/**
 * The icon name for a topic, given the section it belongs to.
 *
 * Callers pass the *section's* slug: a leaf's own slug is never a key here, so passing one by
 * mistake silently returns the fallback rather than throwing — which is the right failure for
 * a decoration, and the reason the two arguments are one.
 */
export const topicIcon = (sectionSlug: string | null | undefined): string =>
  SECTION_ICON[sectionSlug ?? ""] ?? "topics";

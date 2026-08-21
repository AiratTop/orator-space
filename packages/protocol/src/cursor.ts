/**
 * Feed cursors (SPEC §12.2, §44.3).
 *
 * §12.2 makes the Article ID the pagination cursor, and for anything ordered by id that
 * is exactly right. The `latest` feed is not ordered by id: an article is created once and
 * published later, sometimes much later, so creation order and publication order diverge.
 * Paginating that feed by id would silently skip articles that were held as drafts.
 *
 * So the cursor for a published feed carries both keys — the sort key and the id that
 * breaks its ties — and stays opaque, which is what lets its shape change later without
 * breaking a client that stored one.
 */
export interface FeedCursor {
  publishedAt: string;
  id: string;
}

const toBase64Url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (value: string): string => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
};

export const encodeFeedCursor = (cursor: FeedCursor): string =>
  toBase64Url(`${cursor.publishedAt} ${cursor.id}`);

/** Returns null for anything malformed: a bad cursor is a first page, not an error. */
export function decodeFeedCursor(value: string | null | undefined): FeedCursor | null {
  if (!value) return null;
  try {
    const [publishedAt, id] = fromBase64Url(value).split(" ");
    if (publishedAt === undefined || id === undefined || id === "") return null;
    return { publishedAt, id };
  } catch {
    return null;
  }
}

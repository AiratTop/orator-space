import { isProfileTab, loadProfile, type Profile, type ProfileTab } from "@orator/core";
import { decodeFeedCursor, isOratorId } from "@orator/protocol";
import { ports } from "./ports.js";

/**
 * Loading a profile, once, for the two routes that render one (SPEC §49.2).
 *
 * `/@{username}` is the articles tab and `/@{username}/{tab}` is the other two. They are two
 * files because Astro routes on path segments, and everything they do apart from naming the
 * tab is identical — so it lives here, where a rule cannot hold on one route and not the
 * other.
 */

export type ProfileLoad =
  | { kind: "response"; response: Response }
  | { kind: "missing"; username: string | null }
  | { kind: "ok"; profile: Profile; tab: ProfileTab };

/** `/@{username}` is the articles tab's only address; `/@{username}/articles` redirects. */
export const profilePath = (username: string, tab: ProfileTab): string =>
  tab === "articles" ? `/@${username}` : `/@${username}/${tab}`;

export async function loadProfilePage(
  handle: string,
  requestedTab: string | null,
  url: URL,
): Promise<ProfileLoad> {
  const username = handle.startsWith("@") ? handle.slice(1) : null;
  if (username === null) return { kind: "missing", username: null };

  /*
   * An unknown tab is not a tab of an unknown profile.
   *
   * `/@somebody/nonsense` answers 404 rather than falling back to the articles tab: a
   * silent fallback makes a mistyped address look like a working one, and §13's rule that
   * one document has one address applies to a profile as much as to an article.
   */
  if (requestedTab !== null && !isProfileTab(requestedTab)) {
    return { kind: "missing", username };
  }
  const tab: ProfileTab = requestedTab === null ? "articles" : requestedTab;

  // One canonical address per tab. `/@x/articles` is the same page as `/@x`, and two
  // addresses for one page is two entries in a cache keyed by the URL (§33.2).
  if (requestedTab === "articles") {
    return {
      kind: "response",
      response: new Response(null, { status: 301, headers: { location: `/@${username}` } }),
    };
  }

  /*
   * The two kinds of cursor this page takes, each validated before it reaches a query.
   *
   * The articles tab pages a feed and carries an encoded `(published_at, id)` pair in both
   * directions; comments and citations page by id alone, because an Orator id is
   * time-ordered and unique on its own (§12.2). An id that is not one is treated as absent
   * rather than passed down — the repository would find nothing either way, but a value
   * from a query string should stop being arbitrary at the first place that can say so.
   */
  const rawBefore = url.searchParams.get("before");
  const beforeId = rawBefore !== null && isOratorId(rawBefore) ? rawBefore : null;

  const loaded = await loadProfile(ports, username, {
    tab,
    ...(tab === "articles"
      ? {
          window: {
            before: decodeFeedCursor(url.searchParams.get("before")),
            after: decodeFeedCursor(url.searchParams.get("after")),
          },
        }
      : { before: beforeId }),
  });

  if (!loaded.ok) return { kind: "missing", username };
  return { kind: "ok", profile: loaded.value, tab };
}

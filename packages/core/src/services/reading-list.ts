import { ErrorType } from "@orator/protocol";
import type { ArticleCard, ReadingListRepo } from "../ports/index.js";
import { fail, ok, type Ports, type Result } from "./context.js";
import { pageSize, type ReadingPorts } from "./reading.js";

/**
 * A private reading list (SPEC §49.2, ADR 0011).
 *
 * ADR 0011 declined likes, bookmarks and saves and named this exception outright: "a reading
 * list under `/settings`, never rendered on a cached page… belongs to whichever phase takes
 * up `/settings`, if a reader ever asks for it". One asked.
 *
 * Nothing here is reversed by that. What the ADR refused was a *counter* — a number on a card
 * that costs a click to manufacture, which on a network of agents is a number with an
 * unlimited supply. This publishes no number: there is no total on an article, none in the
 * API, and §39's reputation is a pure function of the event log, which a save does not enter.
 *
 * People only, and by construction rather than by rule. The list is reached through a browser
 * session, a session is opened by a passkey, and §9.1 forbids the API accepting a session
 * cookie — so an agent holding a token has no route here. ADR 0011 called "a like restricted
 * to humans" unenforceable and was right about a counter: there, a person's assistant clicking
 * on their behalf is indistinguishable from the person and inflates a public number. Here
 * there is nothing to inflate and nowhere to inflate it from.
 */
export type ReadingListPorts = ReadingPorts & {
  readingList: ReadingListRepo;
  db: Ports["db"];
  clock: Ports["clock"];
};

/** The list a person opens, not a feed a stranger scrolls. Bounded like everything else. */
export async function readingList(
  ports: ReadingListPorts,
  principalId: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<{ cards: ArticleCard[]; next: string | null }> {
  const limit = pageSize(options.limit);
  const cards = await ports.readingList.list(principalId, limit + 1, options.before ?? null);
  const page = cards.slice(0, limit);
  return { cards: page, next: cards.length > limit ? (page.at(-1)?.id ?? null) : null };
}

export const isSaved = (ports: ReadingListPorts, principalId: string, articleId: string) =>
  ports.readingList.has(principalId, articleId);

/**
 * Saves, or removes.
 *
 * One function and a boolean rather than two verbs, because the control is one button whose
 * label is the state — and a caller that had to choose between `save` and `unsave` would be
 * choosing from a page that could be a moment out of date.
 *
 * A save of something already saved is a success. Somebody pressing a button twice meant it
 * once, and an error would be the platform arguing with a person about their own list.
 */
export async function setSaved(
  ports: ReadingListPorts,
  principalId: string,
  articleId: string,
  saved: boolean,
): Promise<Result<{ saved: boolean }>> {
  /*
   * The article has to be readable, and the check is the public read model.
   *
   * Not because saving a draft would break anything, but because it would turn this into a
   * yes/no oracle over unpublished work (§43.3) — "did the save succeed" would answer a
   * question about somebody else's drafts.
   */
  const view = await ports.reading.findPublished(articleId);
  if (view === null) return fail(ErrorType.NotFound, "Article not found");

  await ports.db.commit([
    saved
      ? ports.readingList.save(principalId, view.article.id, ports.clock.now().toISOString())
      : ports.readingList.remove(principalId, articleId),
  ]);
  return ok({ saved });
}

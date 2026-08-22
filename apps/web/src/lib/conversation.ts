import type { Conversation } from "@orator/core/ports";

/**
 * How the conversation reads on the page (SPEC §76, §17, §18).
 *
 * Wording only. The parts that decide what is safe to render — the sanitiser over a comment
 * body, the scheme check over an edge's target — live in `@orator/core` with the rest of
 * §57.1, because they are the same decisions the API makes and must not be made twice.
 */

/** Each edge kind said as a sentence, in the direction the reader is looking. */
export const INBOUND_VERB: Record<string, string> = {
  cites: "cites this article",
  supports: "supports this article",
  contradicts: "contradicts this article",
  challenges: "challenges this article",
  summarizes: "summarises this article",
  extends: "extends this article",
  references: "references this article",
};

export const OUTBOUND_VERB: Record<string, string> = {
  cites: "cites",
  supports: "supports",
  contradicts: "contradicts",
  challenges: "challenges",
  summarizes: "summarises",
  extends: "extends",
  references: "references",
};

/**
 * The stance, in words rather than in a token.
 *
 * §17 keeps `stance` on a comment and `kind` on an edge, and they are different claims: a
 * stance is a position taken in a thread, an edge is an assertion about an article. The page
 * says both out loud, because a reader who cannot tell a challenge from a note has no chain
 * to look at.
 */
export const STANCE_LABEL: Record<string, string> = {
  supports: "supports",
  disagrees: "disagrees",
  challenges: "challenges",
  clarifies: "clarifies",
  asks: "asks",
  cites: "cites",
  summarizes: "summarises",
};

/** Disagreement is marked, agreement is not: the reader is looking for the argument. */
export const isContested = (value: string | null): boolean =>
  value === "challenges" || value === "contradicts" || value === "disagrees";

export const isEmpty = (conversation: Conversation): boolean =>
  conversation.comments.length === 0 &&
  conversation.inbound.length === 0 &&
  conversation.outbound.length === 0;

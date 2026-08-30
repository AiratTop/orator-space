import type { AuthorSummary } from "@orator/core/ports";

/**
 * Whether the reader is the party §7.2 holds responsible for a principal.
 *
 * True for themselves, and for an agent they own. It is the same question
 * `createReport` asks in the application service, asked again here for a different purpose:
 * the service decides whether a report is accepted, this decides whether the control that
 * files one is worth offering.
 *
 * **Both are needed, and neither is a substitute.** §43.4 puts the verdict in the application
 * service so REST, MCP and the web reach the same one — a check in a page cannot bind an
 * agent calling the API. But a page that offers an action the service will refuse has told
 * the reader something untrue, and finding out by pressing it is the worst way to learn.
 *
 * Compared by username rather than by id because that is what a profile and a byline carry.
 * §7.3 makes the username unique and canonicalised, so the comparison is exact.
 */
export function answersFor(subject: AuthorSummary, viewerUsername: string | null): boolean {
  if (viewerUsername === null) return false;
  return subject.username === viewerUsername || subject.ownerUsername === viewerUsername;
}

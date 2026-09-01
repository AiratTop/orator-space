import type { PendingNotification } from "../ports/index.js";
import type { TelegramPorts } from "./telegram.js";

/**
 * Saying, in a chat, what the platform has so far only written down (SPEC §9.3, §61.2, §20.5).
 *
 * §61.2 requires that an author be told when something is done to their work, and that
 * requirement has been met by writing a row: a private event, readable through `GET /v1/events`
 * by anybody who thinks to look. An agent does look — that is the whole of §20.5 and it works.
 * A person does not. A platform that removes somebody's article and records the fact in a feed
 * they would have to visit has, in every sense that matters to them, not told them.
 *
 * **This delivers, it does not decide.** Which events have an audience is settled where they
 * are written (§17, §18, §61.2); this reads the ones that do, finds a chat, and says one
 * sentence. Adding a notification means adding an event with an audience, which is where the
 * question "does anybody want to hear this" belongs.
 */

/**
 * How far back a run will look.
 *
 * An hour. The window is not a performance measure — it is what stops switching this on from
 * delivering the entire history of a deployment in one burst, and it encodes something true:
 * a notification about last week is not a notification, it is a nuisance. Anything older is
 * still in the feed, still in the audit log, and still on the article's own page.
 */
export const NOTIFY_WINDOW_MS = 60 * 60 * 1000;

/** One run's ceiling. Telegram allows about thirty messages a second across all chats. */
export const NOTIFY_BATCH = 20;

/**
 * What became of one message (SPEC §9.3).
 *
 * Three outcomes rather than a boolean, because `403` is neither of the two a boolean can
 * express. It is not a failure to retry — the person blocked the bot, which is them saying
 * what they want — and it is not a delivery either. Answering `true` was the first version
 * and it was right about this event and wrong about every one after it: the binding survived
 * untouched, so the next notification called the Bot API and was refused again, for as long
 * as the account existed.
 */
export type Delivery = "sent" | "blocked" | "failed";

export interface Notifier {
  /** `failed` leaves the event pending; `blocked` closes the channel until they write. */
  send(chatId: string, text: string): Promise<Delivery>;
}

export interface DeliveryReport {
  sent: number;
  failed: number;
  /** Chats that refused, each of which cost one call and will not cost a second. */
  blocked: number;
}

/**
 * What each kind of event says, in one sentence.
 *
 * A closed map with a fallback, for the reason §22.3 gives about closed output sets: a type
 * this does not know should produce a plain sentence rather than a template with a hole in
 * it. The sentences name what happened and link to where it happened; they do not quote the
 * comment or the reason, because a notification is an invitation to look rather than a copy
 * of the thing.
 */
const SENTENCE: Record<string, (link: string) => string> = {
  "comment.created": (link) => `Somebody answered your article.\n${link}`,
  "comment.replied": (link) => `Somebody replied to you in a conversation.\n${link}`,
  "article.cited": (link) => `Your article was cited.\n${link}`,
  "article.challenged": (link) => `Your article was challenged.\n${link}`,
  "moderation.actioned": (link) =>
    `A moderator acted on your article. The reason and the decision are on its page, and the ` +
    `action can be appealed.\n${link}`,
  "principal.followed": () => "Somebody started following you.",
};

export function sentenceFor(notification: PendingNotification, siteOrigin: string): string {
  const link =
    notification.subjectType === "article"
      ? `${siteOrigin}/p/${notification.subjectId}`
      : `${siteOrigin}/`;
  const write = SENTENCE[notification.type];
  return write === undefined
    ? `Something happened to your work on Orator.Space.\n${link}`
    : write(link);
}

/**
 * Delivers one batch (SPEC §9.3).
 *
 * Marked delivered only when the send succeeded, one event at a time. The alternative —
 * marking the batch and then sending — turns one bad minute at Telegram into notifications
 * nobody ever receives, and this is the channel a person is told their article was removed
 * through. A duplicate message is a far smaller failure than a silent one, and the primary
 * key on the delivery table keeps even that rare.
 */
export async function deliverNotifications(
  ports: TelegramPorts,
  notifier: Notifier,
  options: { siteOrigin: string; limit?: number },
): Promise<DeliveryReport> {
  const now = ports.clock.now();
  const cutoff = new Date(now.getTime() - NOTIFY_WINDOW_MS).toISOString();
  const pending = await ports.telegram.listPendingNotifications(cutoff, options.limit ?? NOTIFY_BATCH);

  let sent = 0;
  let failed = 0;
  let blocked = 0;

  /*
   * A chat that refuses once in this batch is not called again in it.
   *
   * The query that produced `pending` ran before the first `403`, so it can hold several
   * events for the same chat. Excluding it here is what makes "one call per block" true of a
   * batch as well as of the schedule.
   */
  const refused = new Set<string>();

  for (const notification of pending) {
    if (refused.has(notification.chatId)) continue;

    const delivery = await notifier.send(
      notification.chatId,
      sentenceFor(notification, options.siteOrigin),
    );

    if (delivery === "failed") {
      failed += 1;
      continue;
    }

    if (delivery === "blocked") {
      /*
       * Marked delivered as well as blocked, and the two go together.
       *
       * This event was carried to somebody who has said they do not want it, and leaving it
       * pending would keep it in the window for an hour of runs that now skip the chat
       * anyway. The channel closing is the part that matters, and it is closed for
       * everything, not for this event.
       */
      refused.add(notification.chatId);
      await ports.db.commit([
        ports.telegram.markDelivered(notification.eventId, now.toISOString()),
        ports.telegram.markChannelUnavailable(notification.recipientPrincipalId, now.toISOString()),
      ]);
      blocked += 1;
      continue;
    }

    await ports.db.commit([ports.telegram.markDelivered(notification.eventId, now.toISOString())]);
    sent += 1;
  }

  return { sent, failed, blocked };
}

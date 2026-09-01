import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { deliverNotifications, NOTIFY_WINDOW_MS, sentenceFor } from "./notifications.js";

/**
 * Saying it in a chat (SPEC §9.3, §61.2, §20.5).
 *
 * §61.2 is met today by writing a row, and a row is a notification only to something that
 * reads rows. The assertions here are about the two ways a delivery channel fails a person:
 * saying nothing, and saying it twice.
 */

let ports: ReturnType<typeof createMemoryPorts>;
const PERSON = "PERSON-1";
const AGENT = "AGENT-1";
const NOW = new Date("2026-08-28T12:00:00.000Z");
const ORIGIN = "https://orator.space";

const sent: { chatId: string; text: string }[] = [];
const notifier = {
  async send(chatId: string, text: string) {
    sent.push({ chatId, text });
    return "sent" as const;
  },
};
const failing = { async send() { return "failed" as const; } };
/** Telegram's `403`: the person blocked the bot, and the call still happened. */
const blocking = {
  async send(chatId: string, text: string) {
    sent.push({ chatId, text });
    return "blocked" as const;
  },
};

const principal = (id: string, extra: Record<string, unknown> = {}) => ({
  id: id as never,
  kind: "human" as const,
  username: id.toLowerCase(),
  usernameSkeleton: id.toLowerCase(),
  displayName: null,
  bio: null,
  status: "active" as const,
  platformRole: "user" as const,
  systemAccount: false,
  avatarMediaId: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

const event = (type: string, audience: string, at = NOW.toISOString()) => {
  const id = `E${state.n++}`;
  ports.state.events.push({
    id: id as never,
    type,
    actorPrincipalId: "SOMEBODY" as never,
    subjectType: "article",
    subjectId: "ART-1" as never,
    audiencePrincipalId: audience as never,
    visibility: "private",
    payload: { schema_version: 1 },
    createdAt: at,
  } as never);
  return id;
};
const state = { n: 1 };

beforeEach(() => {
  ports = createMemoryPorts();
  ports.setNow(NOW);
  sent.length = 0;
  state.n = 1;
  ports.state.principals.set(PERSON, principal(PERSON));
  ports.state.principals.set(AGENT, principal(AGENT, { kind: "agent", ownerPrincipalId: PERSON }));
  ports.state.telegramAccounts.set(PERSON, {
    principalId: PERSON as never,
    telegramUserId: "42",
    chatId: "99",
    username: "reader",
    linkedAt: NOW.toISOString(),
    unavailableSince: null,
  });
});

describe("who hears about it", () => {
  it("tells the person whose work it was", async () => {
    event("comment.created", PERSON);
    const report = await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN });

    expect(report).toEqual({ sent: 1, failed: 0, blocked: 0 });
    expect(sent[0]?.chatId).toBe("99");
    expect(sent[0]?.text).toContain("answered your article");
    expect(sent[0]?.text).toContain(`${ORIGIN}/p/ART-1`);
  });

  it("tells an agent's owner, because an agent has no Telegram (§7.2)", async () => {
    // §9.1 opens a session with a passkey and agents hold tokens, so an agent cannot link a
    // chat. Its owner is not a fallback — they are the person accountable for it.
    event("article.challenged", AGENT);
    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({ sent: 1, failed: 0, blocked: 0 });
    expect(sent[0]?.chatId).toBe("99");
  });

  it("says nothing to somebody with no chat", async () => {
    ports.state.telegramAccounts.delete(PERSON);
    event("comment.created", PERSON);
    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({ sent: 0, failed: 0, blocked: 0 });
  });
});

describe("saying it once", () => {
  it("does not repeat an event on the next run", async () => {
    event("comment.created", PERSON);
    await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN });
    const second = await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN });

    expect(second).toEqual({ sent: 0, failed: 0, blocked: 0 });
    expect(sent).toHaveLength(1);
  });

  it("leaves an event pending when the send failed, rather than losing it", async () => {
    // The failure this ordering exists for: marking first and sending after turns one bad
    // minute at Telegram into a notification nobody ever receives — on the channel that
    // tells somebody their article was removed.
    event("moderation.actioned", PERSON);
    expect(await deliverNotifications(ports, failing, { siteOrigin: ORIGIN })).toEqual({ sent: 0, failed: 1, blocked: 0 });

    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({ sent: 1, failed: 0, blocked: 0 });
    expect(sent[0]?.text).toContain("A moderator acted");
  });
});

describe("the window", () => {
  it("ignores anything older than an hour", async () => {
    // Not a performance measure: it is what stops switching this on from delivering the
    // history of a deployment in one burst, and a notification about last week is a nuisance.
    event("comment.created", PERSON, new Date(NOW.getTime() - NOTIFY_WINDOW_MS - 1000).toISOString());
    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({ sent: 0, failed: 0, blocked: 0 });
  });

  it("is bounded per run", async () => {
    for (let i = 0; i < 5; i++) event("comment.created", PERSON);
    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN, limit: 2 })).toEqual({
      sent: 2,
      failed: 0,
      blocked: 0,
    });
  });
});

describe("what it says", () => {
  it("names what happened and links to where, without quoting it", () => {
    const text = sentenceFor(
      {
        eventId: "E1" as never,
        type: "comment.created",
        chatId: "99",
        recipientPrincipalId: PERSON as never,
        subjectType: "article",
        subjectId: "ART-1",
        payload: null,
        createdAt: NOW.toISOString(),
      },
      ORIGIN,
    );
    // An invitation to look, not a copy of the thing: a comment quoted into a chat is
    // untrusted text (§58.1) rendered somewhere this platform does not control.
    expect(text).toBe(`Somebody answered your article.\n${ORIGIN}/p/ART-1`);
  });

  it("has a plain sentence for a type it does not know", () => {
    const text = sentenceFor(
      {
        eventId: "E2" as never,
        type: "something.new",
        chatId: "99",
        recipientPrincipalId: PERSON as never,
        subjectType: "article",
        subjectId: "ART-9",
        payload: null,
        createdAt: NOW.toISOString(),
      },
      ORIGIN,
    );
    expect(text).toContain("Something happened to your work");
    expect(text).toContain("/p/ART-9");
  });
});

describe("a chat that has blocked the bot (§9.3)", () => {
  /**
   * `403` was counted as a delivery, which is right about the event and wrong about every
   * one after it: the binding survived untouched, so the next notification called the Bot
   * API and was refused again — one wasted call per event, for as long as the account
   * existed. The middle of the three available answers is taken: the binding stays, because
   * it is still how they sign in, and the sending stops until they write to the bot.
   */
  it("closes the channel rather than the account", async () => {
    event("comment.created", PERSON);
    expect(await deliverNotifications(ports, blocking, { siteOrigin: ORIGIN })).toEqual({
      sent: 0,
      failed: 0,
      blocked: 1,
    });

    const account = ports.state.telegramAccounts.get(PERSON);
    expect(account?.unavailableSince).toBe(NOW.toISOString());
    // Not unlinked: this is the channel a lost passkey is recovered through (§9.1).
    expect(account?.chatId).toBe("99");
  });

  it("costs one call, and the next event costs none", async () => {
    event("comment.created", PERSON);
    await deliverNotifications(ports, blocking, { siteOrigin: ORIGIN });

    event("article.cited", PERSON);
    expect(await deliverNotifications(ports, blocking, { siteOrigin: ORIGIN })).toEqual({
      sent: 0,
      failed: 0,
      blocked: 0,
    });
    expect(sent).toHaveLength(1);
  });

  it("does not call a refused chat again inside the same batch", async () => {
    // The query ran before the first refusal, so the batch can hold several events for one
    // chat. Without this, "one call per block" would be true of the schedule and not of a run.
    for (let i = 0; i < 3; i++) event("comment.created", PERSON);
    expect(await deliverNotifications(ports, blocking, { siteOrigin: ORIGIN })).toEqual({
      sent: 0,
      failed: 0,
      blocked: 1,
    });
    expect(sent).toHaveLength(1);
  });

  it("keeps the date of the first refusal, not the latest", async () => {
    // What an operator reads as "since" answers "when did this stop", so a second refusal
    // must leave it alone. Asserted on the repository directly: after the first one the chat
    // is no longer a recipient the query returns, which is the point of the column.
    const later = new Date(NOW.getTime() + 60_000).toISOString();
    await ports.db.commit([ports.telegram.markChannelUnavailable(PERSON, NOW.toISOString())]);
    await ports.db.commit([ports.telegram.markChannelUnavailable(PERSON, later)]);

    expect(ports.state.telegramAccounts.get(PERSON)?.unavailableSince).toBe(NOW.toISOString());
  });

  it("delivers again once the person reconnects, which clears the block", async () => {
    event("comment.created", PERSON);
    await deliverNotifications(ports, blocking, { siteOrigin: ORIGIN });

    const account = ports.state.telegramAccounts.get(PERSON)!;
    await ports.db.commit([ports.telegram.markChannelAvailable(PERSON)]);
    expect(account.unavailableSince).toBeNull();

    event("article.cited", PERSON);
    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({
      sent: 1,
      failed: 0,
      blocked: 0,
    });
  });

  it("does not carry the refused event into the next hour of runs", async () => {
    // It was carried to somebody who said they do not want it. Leaving it pending would keep
    // it in the window for an hour of runs that skip the chat anyway.
    event("comment.created", PERSON);
    await deliverNotifications(ports, blocking, { siteOrigin: ORIGIN });
    await ports.db.commit([ports.telegram.markChannelAvailable(PERSON)]);

    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({
      sent: 0,
      failed: 0,
      blocked: 0,
    });
  });
});

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
const notifier = { async send(chatId: string, text: string) { sent.push({ chatId, text }); return true; } };
const failing = { async send() { return false; } };

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
  });
});

describe("who hears about it", () => {
  it("tells the person whose work it was", async () => {
    event("comment.created", PERSON);
    const report = await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN });

    expect(report).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]?.chatId).toBe("99");
    expect(sent[0]?.text).toContain("answered your article");
    expect(sent[0]?.text).toContain(`${ORIGIN}/p/ART-1`);
  });

  it("tells an agent's owner, because an agent has no Telegram (§7.2)", async () => {
    // §9.1 opens a session with a passkey and agents hold tokens, so an agent cannot link a
    // chat. Its owner is not a fallback — they are the person accountable for it.
    event("article.challenged", AGENT);
    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]?.chatId).toBe("99");
  });

  it("says nothing to somebody with no chat", async () => {
    ports.state.telegramAccounts.delete(PERSON);
    event("comment.created", PERSON);
    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({ sent: 0, failed: 0 });
  });
});

describe("saying it once", () => {
  it("does not repeat an event on the next run", async () => {
    event("comment.created", PERSON);
    await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN });
    const second = await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN });

    expect(second).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it("leaves an event pending when the send failed, rather than losing it", async () => {
    // The failure this ordering exists for: marking first and sending after turns one bad
    // minute at Telegram into a notification nobody ever receives — on the channel that
    // tells somebody their article was removed.
    event("moderation.actioned", PERSON);
    expect(await deliverNotifications(ports, failing, { siteOrigin: ORIGIN })).toEqual({ sent: 0, failed: 1 });

    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({ sent: 1, failed: 0 });
    expect(sent[0]?.text).toContain("A moderator acted");
  });
});

describe("the window", () => {
  it("ignores anything older than an hour", async () => {
    // Not a performance measure: it is what stops switching this on from delivering the
    // history of a deployment in one burst, and a notification about last week is a nuisance.
    event("comment.created", PERSON, new Date(NOW.getTime() - NOTIFY_WINDOW_MS - 1000).toISOString());
    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN })).toEqual({ sent: 0, failed: 0 });
  });

  it("is bounded per run", async () => {
    for (let i = 0; i < 5; i++) event("comment.created", PERSON);
    expect(await deliverNotifications(ports, notifier, { siteOrigin: ORIGIN, limit: 2 })).toEqual({
      sent: 2,
      failed: 0,
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

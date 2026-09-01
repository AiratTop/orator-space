import { beforeEach, describe, expect, it } from "vitest";
import { ErrorType } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import {
  cleanSpentLogins,
  type TelegramContext,
  LINK_TTL_MS,
  LOGIN_TTL_MS,
  newNonce,
  redeemTelegramLink,
  redeemTelegramLogin,
  startTelegramLink,
  startTelegramLogin,
  unlinkTelegram,
} from "./telegram.js";

/**
 * Binding a chat to an account (SPEC §9.3).
 *
 * Every test here is about the nonce, because the nonce is the whole of the security: it is
 * the only thing standing between "somebody pressed start in a chat" and "that chat now
 * receives an account's notifications and can be sent its recovery links". Single use, short
 * lived, and issued by the side that already knows who the person is.
 */

let ports: ReturnType<typeof createMemoryPorts>;
/* The same ports, plus what §62 needs to write a row: who asked, and from where. */
let ctx: TelegramContext;
const PRINCIPAL = "PERSON-1";
const OTHER = "PERSON-2";
const NOW = new Date("2026-08-28T12:00:00.000Z");
const ORIGIN = "https://orator.space";

/* Deterministic, and different per call: two links issued in a row are two credentials. */
let entropy = 0;
const random = () => new Uint8Array(16).fill((entropy += 1));

const start = (principalId = PRINCIPAL) =>
  startTelegramLink(ctx, principalId, { botUsername: "orator_space_bot", random: random() });

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const errorOf = (r: { ok: boolean; error?: { type: string } }) => {
  if (r.ok) throw new Error("expected failure");
  return r.error!.type;
};

beforeEach(() => {
  ports = createMemoryPorts();
  ports.setNow(NOW);
  ctx = { ...ports, requestId: "req-telegram", ipHash: null, userAgent: "a browser" };
});

/** The audit rows this run produced, in order (SPEC §62). */
const journalled = () =>
  ports.state.audit.map((row) => ({
    action: row.action,
    actor: row.actorPrincipalId,
    outcome: row.outcome,
    reason: row.reason,
  }));

describe("issuing a link", () => {
  it("points at the bot and carries a nonce nobody supplied", async () => {
    const link = unwrap(await start());
    expect(link.url).toBe(`https://t.me/orator_space_bot?start=${link.nonce}`);
    expect(link.nonce).toMatch(/^[0-9A-Z]{16}$/);
  });

  it("expires, and the lifetime is the window a stolen copy works in", async () => {
    const link = unwrap(await start());
    expect(Date.parse(link.expiresAt) - NOW.getTime()).toBe(LINK_TTL_MS);
  });

  it("does not invalidate one already issued", async () => {
    // Somebody opens the page on a laptop, loses patience, opens it again, then presses the
    // first link on their phone. Both should work until they expire.
    const first = unwrap(await start());
    const second = unwrap(await start());
    expect(first.nonce).not.toBe(second.nonce);

    const redeemed = await redeemTelegramLink(ctx, { nonce: first.nonce, telegramUserId: "42", chatId: "42" });
    expect(redeemed.ok).toBe(true);
  });
});

describe("redeeming one", () => {
  it("binds the chat to the principal that issued it", async () => {
    const link = unwrap(await start());
    const account = unwrap(
      await redeemTelegramLink(ctx, { nonce: link.nonce, telegramUserId: "42", chatId: "99", username: "reader" }),
    );

    expect(account.principalId).toBe(PRINCIPAL);
    // The chat is stored beside the user id: a bot sends to a chat, and nothing in the
    // protocol promises the two numbers are the same.
    expect(account.chatId).toBe("99");
    expect(account.username).toBe("reader");
  });

  it("works once", async () => {
    const link = unwrap(await start());
    unwrap(await redeemTelegramLink(ctx, { nonce: link.nonce, telegramUserId: "42", chatId: "42" }));

    const again = await redeemTelegramLink(ctx, { nonce: link.nonce, telegramUserId: "77", chatId: "77" });
    expect(errorOf(again)).toBe(ErrorType.Conflict);
    // And the second attempt changed nothing: the first chat still holds the binding.
    expect((await ports.telegram.findByPrincipal(PRINCIPAL))?.telegramUserId).toBe("42");
  });

  it("refuses one that has expired", async () => {
    const link = unwrap(await start());
    ports.setNow(new Date(NOW.getTime() + LINK_TTL_MS + 1000));
    expect(errorOf(await redeemTelegramLink(ctx, { nonce: link.nonce, telegramUserId: "42", chatId: "42" }))).toBe(
      ErrorType.Conflict,
    );
  });

  it("refuses a nonce that never existed", async () => {
    // The guessing case. Eight characters of a 32-symbol alphabet is not guessable, and the
    // answer says nothing about which accounts have links outstanding.
    expect(errorOf(await redeemTelegramLink(ctx, { nonce: "NOTANONCE1234567", telegramUserId: "42", chatId: "42" }))).toBe(
      ErrorType.NotFound,
    );
  });

  it("refuses a Telegram account that already belongs to somebody else (§9.3)", async () => {
    unwrap(await redeemTelegramLink(ctx, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));

    const theirs = unwrap(await start(OTHER));
    expect(errorOf(await redeemTelegramLink(ctx, { nonce: theirs.nonce, telegramUserId: "42", chatId: "42" }))).toBe(
      ErrorType.Conflict,
    );
    expect(await ports.telegram.findByPrincipal(OTHER)).toBeNull();
  });

  it("lets the same person re-link the same chat", async () => {
    unwrap(await redeemTelegramLink(ctx, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));
    const second = unwrap(await start());
    expect((await redeemTelegramLink(ctx, { nonce: second.nonce, telegramUserId: "42", chatId: "51" })).ok).toBe(true);
    expect((await ports.telegram.findByPrincipal(PRINCIPAL))?.chatId).toBe("51");
  });
});

describe("disconnecting", () => {
  it("removes the binding, and the chat can then be linked elsewhere (§23.5)", async () => {
    unwrap(await redeemTelegramLink(ctx, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));
    unwrap(await unlinkTelegram(ctx, PRINCIPAL, "settings"));

    expect(await ports.telegram.findByPrincipal(PRINCIPAL)).toBeNull();
    const theirs = unwrap(await start(OTHER));
    expect((await redeemTelegramLink(ctx, { nonce: theirs.nonce, telegramUserId: "42", chatId: "42" })).ok).toBe(true);
  });
});

describe("the nonce itself", () => {
  it("uses an alphabet with no ambiguous characters", () => {
    // It is read off a screen and sometimes typed. I, L, O and U are absent for the reason
    // §12.2 gives for the id alphabet: they are the ones people get wrong.
    const nonce = newNonce(new Uint8Array(32).map((_, i) => i));
    expect(nonce).not.toMatch(/[ILOU]/);
  });
});

/**
 * Signing in from the chat (SPEC §9.3, §9.1).
 *
 * The recovery path §9 asks for, and the reason it is safe is the binding: the chat was
 * connected by somebody who was signed in, so a message from it is a message from that
 * account's owner. What must hold is that the secret it hands out is spent exactly once and
 * dies quickly — it opens a session, which is the account.
 */
describe("a login link", () => {
  const connect = async () =>
    unwrap(await redeemTelegramLink(ctx, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));

  it("is refused to a chat that is not connected", async () => {
    expect(errorOf(await startTelegramLogin(ctx, "999", { siteOrigin: ORIGIN, random: random() }))).toBe(
      ErrorType.NotFound,
    );
  });

  it("points at this site and carries a nonce", async () => {
    await connect();
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    expect(login.url).toBe(`${ORIGIN}/auth/telegram?token=${login.nonce}`);
  });

  it("lives two minutes, not ten", async () => {
    // Binding a chat is reversible; this is the account. The lifetime is the window in which
    // a copy of the chat — a shared screen, a forwarded message — is worth anything.
    await connect();
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    expect(Date.parse(login.expiresAt) - NOW.getTime()).toBe(LOGIN_TTL_MS);
  });

  it("answers with the principal the chat belongs to", async () => {
    await connect();
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    expect(unwrap(await redeemTelegramLogin(ctx, login.nonce)).principalId).toBe(PRINCIPAL);
  });

  it("is spent once, and the second attempt is refused", async () => {
    await connect();
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    unwrap(await redeemTelegramLogin(ctx, login.nonce));
    expect(errorOf(await redeemTelegramLogin(ctx, login.nonce))).toBe(ErrorType.NotFound);
  });

  it("expires", async () => {
    await connect();
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    ports.setNow(new Date(NOW.getTime() + LOGIN_TTL_MS + 1000));
    expect(errorOf(await redeemTelegramLogin(ctx, login.nonce))).toBe(ErrorType.NotFound);
  });

  it("answers every failure the same way", async () => {
    // A link that never existed and one used a minute ago are the same fact to whoever holds
    // it; telling them apart tells somebody which guesses are close.
    expect(errorOf(await redeemTelegramLogin(ctx, "NEVEREXISTED1234"))).toBe(ErrorType.NotFound);
  });

  it("cannot be used as a linking nonce, nor a link as a login", async () => {
    // The two tables exist separately for this: one binds a chat and cannot open a session,
    // the other opens a session and cannot bind a chat.
    await connect();
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    expect(errorOf(await redeemTelegramLink(ctx, { nonce: login.nonce, telegramUserId: "7", chatId: "7" }))).toBe(
      ErrorType.NotFound,
    );

    const link = unwrap(await start(OTHER));
    expect(errorOf(await redeemTelegramLogin(ctx, link.nonce))).toBe(ErrorType.NotFound);
  });
});

/**
 * Taking a spent link back out of the chat (SPEC §9.3).
 *
 * Housekeeping, not security — the link stopped working when it was pressed. What it fixes is
 * a message that still says "press this to sign in" long after it will do anything.
 */
describe("cleaning up after a login", () => {
  const connect = async () =>
    unwrap(await redeemTelegramLink(ctx, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "77" }));

  const issue = async () => {
    await connect();
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    await ports.db.commit([ports.telegram.recordLoginMessage(login.nonce, "555")]);
    return login;
  };

  it("leaves a link that has not been used", async () => {
    await issue();
    const removed: string[] = [];
    expect(await cleanSpentLogins(ports, async (_chat, id) => void removed.push(id))).toBe(0);
    expect(removed).toEqual([]);
  });

  it("removes the message once the link is spent", async () => {
    const login = await issue();
    unwrap(await redeemTelegramLogin(ctx, login.nonce));

    const removed: { chat: string; id: string }[] = [];
    expect(await cleanSpentLogins(ports, async (chat, id) => void removed.push({ chat, id }))).toBe(1);
    expect(removed).toEqual([{ chat: "77", id: "555" }]);
  });

  it("asks once, even when Telegram refuses", async () => {
    // A message somebody deleted themselves, or one past Telegram's 48-hour window, will
    // never be deletable; retrying it forever is a queue that never drains.
    const login = await issue();
    unwrap(await redeemTelegramLogin(ctx, login.nonce));

    await cleanSpentLogins(ports, async () => {
      throw new Error("message to delete not found");
    });

    const again: string[] = [];
    expect(await cleanSpentLogins(ports, async (_chat, id) => void again.push(id))).toBe(0);
  });

  it("ignores a login whose message was never sent", async () => {
    await connect();
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    unwrap(await redeemTelegramLogin(ctx, login.nonce));
    expect(await cleanSpentLogins(ports, async () => undefined)).toBe(0);
  });
});

/**
 * SPEC §62 — a credential operation that leaves no row (§13.37).
 *
 * §42.2 calls a bound chat a credential and the five operations on it wrote nothing to
 * `audit_log`: the Worker's log is kept for days and cannot be queried by principal, so an
 * account holder asking "who connected this chat, and when was a sign-in link issued" had
 * nowhere to look. These assertions are about what the row says, not that one exists —
 * a row naming the wrong principal is worse than no row.
 */
describe("what is written down (§62)", () => {
  it("records the issue of a linking nonce against the account that asked", async () => {
    await start();
    expect(journalled()).toEqual([
      { action: "telegram.link.issued", actor: PRINCIPAL, outcome: "success", reason: null },
    ]);
  });

  it("records the binding, in the transaction that makes it", async () => {
    const link = unwrap(await start());
    await redeemTelegramLink(ctx, { nonce: link.nonce, telegramUserId: "42", chatId: "99" });

    expect(journalled().at(-1)).toEqual({
      action: "telegram.linked",
      actor: PRINCIPAL,
      outcome: "success",
      reason: null,
    });
  });

  it("names nobody for a nonce that never existed, rather than guessing", async () => {
    // The chat said who it was; the platform believes that only where a nonce resolves. A
    // row naming a principal here would be a claim the update made, written down as a fact.
    await redeemTelegramLink(ctx, { nonce: "NOTANONCE1234567", telegramUserId: "42", chatId: "42" });
    expect(journalled()).toEqual([
      { action: "telegram.linked", actor: null, outcome: "denied", reason: "unknown-nonce" },
    ]);
  });

  it("distinguishes the refusals, which is the whole content of the row", async () => {
    const spent = unwrap(await start());
    unwrap(await redeemTelegramLink(ctx, { nonce: spent.nonce, telegramUserId: "42", chatId: "42" }));
    await redeemTelegramLink(ctx, { nonce: spent.nonce, telegramUserId: "43", chatId: "43" });

    const expired = unwrap(await start());
    ports.setNow(new Date(NOW.getTime() + LINK_TTL_MS + 1000));
    await redeemTelegramLink(ctx, { nonce: expired.nonce, telegramUserId: "44", chatId: "44" });
    ports.setNow(NOW);

    const theirs = unwrap(await start(OTHER));
    await redeemTelegramLink(ctx, { nonce: theirs.nonce, telegramUserId: "42", chatId: "42" });

    const denials = journalled().filter((row) => row.outcome === "denied");
    expect(denials.map((row) => row.reason)).toEqual([
      "already-used",
      "expired",
      "telegram-account-taken",
    ]);
    // Every one of them names the account whose nonce it was, which is who would ask.
    expect(denials.map((row) => row.actor)).toEqual([PRINCIPAL, PRINCIPAL, OTHER]);
  });

  it("records a sign-in link when it is issued and again when it is spent", async () => {
    unwrap(await redeemTelegramLink(ctx, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    unwrap(await redeemTelegramLogin(ctx, login.nonce));

    expect(journalled().slice(-2)).toEqual([
      { action: "telegram.login.issued", actor: PRINCIPAL, outcome: "success", reason: null },
      { action: "telegram.login.used", actor: PRINCIPAL, outcome: "success", reason: null },
    ]);
  });

  it("records a second press of a spent link as a denial, though the chat is told nothing", async () => {
    unwrap(await redeemTelegramLink(ctx, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));
    const login = unwrap(await startTelegramLogin(ctx, "42", { siteOrigin: ORIGIN, random: random() }));
    unwrap(await redeemTelegramLogin(ctx, login.nonce));
    await redeemTelegramLogin(ctx, login.nonce);

    expect(journalled().at(-1)).toEqual({
      action: "telegram.login.used",
      actor: PRINCIPAL,
      outcome: "denied",
      reason: "already-used",
    });
  });

  it("records /login from an unconnected chat, naming nobody", async () => {
    // Ordinarily somebody who found the bot. Many of them, from many chats, is somebody
    // looking for one that answers — and nothing else keeps that for longer than a log line.
    expect(errorOf(await startTelegramLogin(ctx, "999", { siteOrigin: ORIGIN, random: random() }))).toBe(
      ErrorType.NotFound,
    );
    expect(journalled()).toEqual([
      { action: "telegram.login.issued", actor: null, outcome: "denied", reason: "chat-not-connected" },
    ]);
  });

  it("says where a disconnection came from, because the two are not the same act", async () => {
    unwrap(await redeemTelegramLink(ctx, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));
    unwrap(await unlinkTelegram(ctx, PRINCIPAL, "chat"));

    expect(journalled().at(-1)).toEqual({
      action: "telegram.unlinked",
      actor: PRINCIPAL,
      outcome: "success",
      reason: "from=chat",
    });
  });

  it("carries the request id and the user agent the surface handed it", async () => {
    await start();
    expect(ports.state.audit[0]).toMatchObject({
      requestId: "req-telegram",
      userAgent: "a browser",
      targetType: "telegram",
      targetId: PRINCIPAL,
    });
  });
});

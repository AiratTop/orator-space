import { beforeEach, describe, expect, it } from "vitest";
import { ErrorType } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { LINK_TTL_MS, newNonce, redeemTelegramLink, startTelegramLink, unlinkTelegram } from "./telegram.js";

/**
 * Binding a chat to an account (SPEC §9.3).
 *
 * Every test here is about the nonce, because the nonce is the whole of the security: it is
 * the only thing standing between "somebody pressed start in a chat" and "that chat now
 * receives an account's notifications and can be sent its recovery links". Single use, short
 * lived, and issued by the side that already knows who the person is.
 */

let ports: ReturnType<typeof createMemoryPorts>;
const PRINCIPAL = "PERSON-1";
const OTHER = "PERSON-2";
const NOW = new Date("2026-08-28T12:00:00.000Z");

/* Deterministic, and different per call: two links issued in a row are two credentials. */
let entropy = 0;
const random = () => new Uint8Array(16).fill((entropy += 1));

const start = (principalId = PRINCIPAL) =>
  startTelegramLink(ports, principalId, { botUsername: "orator_space_bot", random: random() });

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
});

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

    const redeemed = await redeemTelegramLink(ports, { nonce: first.nonce, telegramUserId: "42", chatId: "42" });
    expect(redeemed.ok).toBe(true);
  });
});

describe("redeeming one", () => {
  it("binds the chat to the principal that issued it", async () => {
    const link = unwrap(await start());
    const account = unwrap(
      await redeemTelegramLink(ports, { nonce: link.nonce, telegramUserId: "42", chatId: "99", username: "reader" }),
    );

    expect(account.principalId).toBe(PRINCIPAL);
    // The chat is stored beside the user id: a bot sends to a chat, and nothing in the
    // protocol promises the two numbers are the same.
    expect(account.chatId).toBe("99");
    expect(account.username).toBe("reader");
  });

  it("works once", async () => {
    const link = unwrap(await start());
    unwrap(await redeemTelegramLink(ports, { nonce: link.nonce, telegramUserId: "42", chatId: "42" }));

    const again = await redeemTelegramLink(ports, { nonce: link.nonce, telegramUserId: "77", chatId: "77" });
    expect(errorOf(again)).toBe(ErrorType.Conflict);
    // And the second attempt changed nothing: the first chat still holds the binding.
    expect((await ports.telegram.findByPrincipal(PRINCIPAL))?.telegramUserId).toBe("42");
  });

  it("refuses one that has expired", async () => {
    const link = unwrap(await start());
    ports.setNow(new Date(NOW.getTime() + LINK_TTL_MS + 1000));
    expect(errorOf(await redeemTelegramLink(ports, { nonce: link.nonce, telegramUserId: "42", chatId: "42" }))).toBe(
      ErrorType.Conflict,
    );
  });

  it("refuses a nonce that never existed", async () => {
    // The guessing case. Eight characters of a 32-symbol alphabet is not guessable, and the
    // answer says nothing about which accounts have links outstanding.
    expect(errorOf(await redeemTelegramLink(ports, { nonce: "NOTANONCE1234567", telegramUserId: "42", chatId: "42" }))).toBe(
      ErrorType.NotFound,
    );
  });

  it("refuses a Telegram account that already belongs to somebody else (§9.3)", async () => {
    unwrap(await redeemTelegramLink(ports, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));

    const theirs = unwrap(await start(OTHER));
    expect(errorOf(await redeemTelegramLink(ports, { nonce: theirs.nonce, telegramUserId: "42", chatId: "42" }))).toBe(
      ErrorType.Conflict,
    );
    expect(await ports.telegram.findByPrincipal(OTHER)).toBeNull();
  });

  it("lets the same person re-link the same chat", async () => {
    unwrap(await redeemTelegramLink(ports, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));
    const second = unwrap(await start());
    expect((await redeemTelegramLink(ports, { nonce: second.nonce, telegramUserId: "42", chatId: "51" })).ok).toBe(true);
    expect((await ports.telegram.findByPrincipal(PRINCIPAL))?.chatId).toBe("51");
  });
});

describe("disconnecting", () => {
  it("removes the binding, and the chat can then be linked elsewhere (§23.5)", async () => {
    unwrap(await redeemTelegramLink(ports, { nonce: unwrap(await start()).nonce, telegramUserId: "42", chatId: "42" }));
    unwrap(await unlinkTelegram(ports, PRINCIPAL));

    expect(await ports.telegram.findByPrincipal(PRINCIPAL)).toBeNull();
    const theirs = unwrap(await start(OTHER));
    expect((await redeemTelegramLink(ports, { nonce: theirs.nonce, telegramUserId: "42", chatId: "42" })).ok).toBe(true);
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

import { Hono } from "hono";
import { redeemTelegramLink, unlinkTelegram } from "@orator/core";
import { createPrincipalRepo, createTelegramRepo, systemClock } from "@orator/adapters-cf";
import { createD1Database } from "@orator/adapters-cf";
import { surfaceFor, type Env } from "../index.js";

/**
 * The Telegram bot, as a webhook (SPEC §9.3).
 *
 * A Worker is the right shape for this: Telegram delivers each update as an HTTPS POST and
 * expects a fast 200, which is one request in and one out with no polling loop to keep alive.
 * The reply to the person is a second call back to Telegram, made while the request is still
 * open — a chat message is what the person is waiting for, so it is not work to defer.
 *
 * **Everything here treats the body as a claim until the header is checked.** The endpoint
 * has to be public for Telegram to reach it, and an update states who somebody is; an
 * unverified webhook is therefore a way for anybody to bind their chat to anybody's account.
 * `X-Telegram-Bot-Api-Secret-Token` is set when the webhook is registered and compared here
 * before the body is read.
 */

type Vars = { requestId: string };

export const telegramRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

interface Update {
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string; username?: string };
  };
}

/**
 * Constant-time comparison for the webhook secret.
 *
 * The difference is unmeasurable over a network for a value this short, and it costs four
 * lines: a comparison that returns early is a habit worth not having in code that decides
 * whether a caller is Telegram.
 */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function say(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (error) {
    // A reply that does not arrive is not a reason to answer Telegram with a failure: it
    // would redeliver the update, and the binding above has already happened.
    console.error(JSON.stringify({ level: "warn", event: "telegram.reply.failed", error: String(error) }));
  }
}

/*
 * The messages, in one place.
 *
 * A bot's whole interface is its sentences, and they are the part somebody reads while
 * deciding whether this platform is careful. Each says what happened and what to do next.
 */
const SAID = {
  /*
   * §9.3 — what this bot is, in the words of somebody who has not read the specification.
   *
   * A bot's whole interface is its sentences. `/help` says what it does and where the button
   * is; it does not explain nonces, and it does not apologise.
   */
  help:
    "Orator.Space is an open publishing network where people and autonomous agents publish, " +
    "read, cite and challenge each other.\n\n" +
    "This bot is how the platform reaches you — a moderation decision, somebody answering " +
    "your article — instead of leaving it in a feed you would have to visit to read.\n\n" +
    "/status — which account this chat belongs to\n\n" +
    "Connect a chat from the Telegram tab of your account settings. Disconnecting is in the " +
    "command menu, and on that same page.",
  notConnected:
    "This chat is not connected to any Orator.Space account. Open the Telegram tab of your " +
    "account settings and press connect — it will bring you back here.",
  /*
   * §9.3 — a destructive command asks twice, and the reason is the interface.
   *
   * Telegram renders `/command` in a message as a button: one tap, no dialogue, done. This
   * one removes the channel a person is told about takedowns through, so it is not something
   * a thumb should be able to do while scrolling. The confirmation is a second deliberate
   * act, and the sentence before it says what will stop.
   */
  confirmDisconnect:
    "This will disconnect the chat from your Orator.Space account: no notifications, and " +
    "nothing about your work will reach you here.\n\n" +
    "To go ahead, send: /disconnect yes",
  disconnected:
    "Disconnected. This chat no longer belongs to any account here and will receive nothing. " +
    "You can connect it again, to this account or another one, from the settings page.",
  welcome:
    "This is Orator.Space. Connect this chat to your account from the settings page — " +
    "it will send you back here with a link that does the binding.",
  linked: (settings: string) =>
    "Connected. This chat now belongs to your Orator.Space account, and is where you will be " +
    "told when something happens to your work.\n\n" +
    // The person is here and the page they came from is behind this window; on a phone it is
    // behind the whole application. A way back is one line and saves a hunt through tabs.
    `Back to your account: ${settings}`,
  expired:
    "That link is no longer usable — it may have expired, or it may already have been used. " +
    "Open the settings page again and start a new one.",
  taken:
    "That Telegram account is already connected to another Orator.Space account. Disconnect " +
    "it there first: one Telegram account belongs to one account here.",
} as const;

telegramRoutes.post("/telegram/webhook", async (c) => {
  /*
   * §57.4 — on the API surface and nowhere else.
   *
   * The Worker answers on three hostnames and this route would otherwise exist on all of
   * them, including the one that serves user-uploaded bytes. A webhook is a credentialed
   * endpoint; it belongs on the origin that already holds credentials, not on the one that
   * exists to hold none.
   */
  if (surfaceFor(new URL(c.req.url).hostname) !== "api") return c.notFound();

  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  const token = c.env.TELEGRAM_BOT_TOKEN;

  /*
   * A deployment with no bot configured answers 404 rather than 500.
   *
   * The route exists in every environment because the code is one bundle; a staging Worker
   * with no token has no bot, and saying "there is nothing at this address" is true.
   */
  if (secret === undefined || token === undefined) return c.notFound();

  const presented = c.req.header("x-telegram-bot-api-secret-token") ?? "";
  if (!sameSecret(presented, secret)) {
    // Not a problem document: this is not an API for anybody to call, and an error that
    // explains itself is an error that helps somebody guess.
    return c.text("", 401);
  }

  const update = (await c.req.json().catch(() => null)) as Update | null;
  const text = update?.message?.text ?? "";
  const chatId = String(update?.message?.chat?.id ?? "");
  const from = update?.message?.from;

  // Telegram redelivers an update it did not get a 200 for. Anything this bot does not
  // understand is acknowledged rather than retried forever.
  if (chatId === "" || from?.id === undefined) return c.text("ok");

  const telegramUserId = String(from.id);
  const repo = createTelegramRepo(c.env.DB);
  const command = text.trim().split(/\s+/)[0]?.replace(/@\w+$/, "").toLowerCase() ?? "";

  /*
   * The commands, and why there are only three.
   *
   * A command list is a promise: it appears in a menu and somebody presses it. These are the
   * three that work on a chat by itself — the fourth thing anybody would want, signing in
   * through Telegram, is not built, so it is not offered (§9.3).
   */
  if (command === "/help") {
    await say(token, chatId, SAID.help);
    return c.text("ok");
  }

  if (command === "/status") {
    const account = await repo.findByTelegramUser(telegramUserId);
    if (account === null) {
      await say(token, chatId, SAID.notConnected);
      return c.text("ok");
    }

    /*
     * Named, not merely acknowledged.
     *
     * "an Orator.Space account" is no answer to somebody who has two, and this message
     * reaches exactly one chat — the one the account is bound to — so the handle it prints is
     * the reader's own. One extra read, on a command nobody presses in a loop.
     */
    /*
     * Without the `@`, and that is not a style choice.
     *
     * Telegram turns `@name` in any message into a mention of the Telegram account with that
     * name — a different person entirely, whom this would link a reader to. Handles here and
     * handles there share a syntax and nothing else, so the address is written out in full
     * instead, where it points at this platform and can be checked.
     */
    const principal = await createPrincipalRepo(c.env.DB).findById(account.principalId);
    const who =
      principal === null
        ? "an account"
        : `${principal.username} (https://${c.env.SITE_HOST}/@${principal.username})`;
    await say(
      token,
      chatId,
      `This chat belongs to ${who} on Orator.Space, connected on ${account.linkedAt.slice(0, 10)}.`,
    );
    return c.text("ok");
  }

  if (command === "/disconnect") {
    /*
     * Confirmed by the word after it, rather than by a button.
     *
     * An inline keyboard would be prettier and would mean subscribing to `callback_query`
     * updates — a second kind of update to verify, parse and answer, for a confirmation that
     * two words already provide.
     */
    const confirmed = /^\/disconnect(?:@\w+)?\s+(yes|confirm)$/i.test(text.trim());
    if (!confirmed) {
      const account = await repo.findByTelegramUser(telegramUserId);
      await say(token, chatId, account === null ? SAID.notConnected : SAID.confirmDisconnect);
      return c.text("ok");
    }

    /*
     * From the chat as well as from the page, and it is not a duplicate of that button.
     *
     * The person who needs this most is the one who cannot reach the settings page: a lost
     * passkey, a device that changed hands. Disconnecting grants nothing — it removes a
     * channel — so the chat is allowed to do it for itself (§23.5).
     */
    const account = await repo.findByTelegramUser(telegramUserId);
    if (account === null) {
      await say(token, chatId, SAID.notConnected);
      return c.text("ok");
    }
    await unlinkTelegram(
      { telegram: repo, db: createD1Database(c.env.DB), clock: systemClock },
      account.principalId,
    );
    await say(token, chatId, SAID.disconnected);
    console.log(JSON.stringify({ level: "info", event: "telegram.unlinked", from: "chat" }));
    return c.text("ok");
  }

  const start = /^\/start(?:@\w+)?(?:\s+([0-9A-Z]{8,64}))?$/.exec(text.trim());
  if (start === null) {
    await say(token, chatId, SAID.welcome);
    return c.text("ok");
  }

  const nonce = start[1];
  if (nonce === undefined) {
    await say(token, chatId, SAID.welcome);
    return c.text("ok");
  }

  const ports = { telegram: repo, db: createD1Database(c.env.DB), clock: systemClock };

  const result = await redeemTelegramLink(ports, {
    nonce,
    telegramUserId,
    chatId,
    ...(from.username === undefined ? {} : { username: from.username }),
  });

  if (!result.ok) {
    const already = result.error.title.includes("already connected");
    await say(token, chatId, already ? SAID.taken : SAID.expired);
    /*
     * Logged with the reason, and the reason matters to an operator: an expired link is an
     * ordinary thing that happens to honest people, and a nonce that never existed is
     * somebody guessing at an eight-character credential.
     */
    console.log(
      JSON.stringify({ level: "info", event: "telegram.link.refused", reason: result.error.title }),
    );
    return c.text("ok");
  }

  await say(token, chatId, SAID.linked(`https://${c.env.SITE_HOST}/settings?tab=telegram`));
  /*
   * And what the bot can do, immediately after.
   *
   * A second message rather than a longer first one: the first answers the thing they just
   * did, and the second is a reference they will scroll back to. Somebody who has just
   * connected is the one person certain to read both.
   */
  await say(token, chatId, SAID.help);
  console.log(JSON.stringify({ level: "info", event: "telegram.link.made" }));
  return c.text("ok");
});

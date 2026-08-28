import { Hono } from "hono";
import { redeemTelegramLink } from "@orator/core";
import { createTelegramRepo, systemClock } from "@orator/adapters-cf";
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
  welcome:
    "This is Orator.Space. Connect this chat to your account from the settings page — " +
    "it will send you back here with a link that does the binding.",
  linked:
    "Connected. This chat now belongs to your Orator.Space account, and is where you will be " +
    "told when something happens to your work.",
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

  const ports = {
    telegram: createTelegramRepo(c.env.DB),
    db: createD1Database(c.env.DB),
    clock: systemClock,
  };

  const result = await redeemTelegramLink(ports, {
    nonce,
    telegramUserId: String(from.id),
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

  await say(token, chatId, SAID.linked);
  console.log(JSON.stringify({ level: "info", event: "telegram.link.made" }));
  return c.text("ok");
});

import { ErrorType } from "@orator/protocol";
import type { OratorId } from "@orator/protocol";
import type { PendingWrite, TelegramAccount, TelegramLink, TelegramRepo } from "../ports/index.js";
import { fail, journal, ok, type Ports, type Result } from "./context.js";

/**
 * Binding a Telegram account to a principal (SPEC §9.3).
 *
 * The second channel, and the first half of it: linking. A platform that removes somebody's
 * article and tells them through an event feed has told nobody, and a platform whose only
 * credential is a passkey on one device has no answer when that device is lost. Both need a
 * way to reach a person who is not at the site.
 *
 * The direction of trust is the whole design. The site issues a nonce to somebody who is
 * already signed in; the bot presents that nonce together with a Telegram identity that
 * Telegram itself vouched for. Neither side is asked to believe a claim the other made about
 * who they are — which is what would happen if a browser could post a Telegram id, or if the
 * bot could name a principal.
 */

export interface TelegramPorts {
  telegram: TelegramRepo;
  db: Pick<Ports["db"], "commit">;
  clock: Ports["clock"];
}

/**
 * What linking, unlinking and signing in need beyond the repositories (SPEC §62).
 *
 * §42.2 calls a bound chat a credential and §62 requires that credential operations be
 * recorded; none of these five was, and the Worker's own log is not the same thing — it is
 * kept for days and cannot be queried by principal. So the operations that create, spend or
 * destroy this credential take a context rather than a port bag, and write their row in the
 * transaction that makes the change (§35).
 *
 * Delivery and cleanup keep taking `TelegramPorts`: they act on nobody's authority and
 * create no credential, so a row for each would be a log of the schedule running.
 */
export interface TelegramContext extends TelegramPorts {
  ids: Ports["ids"];
  audit: Ports["audit"];
  /** SPEC §66.1 — the same identifier the request carries everywhere else. */
  requestId: string;
  /**
   * SPEC §62 — null on the webhook, and that is the honest value.
   *
   * The address a webhook arrives from is Telegram's, not the person's, so a pseudonym of it
   * answers no question an audit asks and would put one operator's infrastructure into the
   * column that exists to identify a caller. The browser half of these operations does have
   * an address, and passes it.
   */
  ipHash: string | null;
  userAgent: string | null;
}

/**
 * The audit row for one of them, and the actor is never taken from the message.
 *
 * A chat states who it is and the platform believes exactly one thing about that: which
 * principal the binding was recorded against, by a signed-in browser (§9.3). So the caller
 * hands in the principal it *resolved*, and `null` where nothing resolved — a nonce that
 * never existed names nobody, and a row claiming otherwise would be a guess written down as
 * a fact.
 */
function journalTelegram(
  ctx: TelegramContext,
  action: string,
  principalId: string | null,
  outcome: "success" | "denied",
  reason: string | null,
): PendingWrite {
  return journal(
    {
      ports: { audit: ctx.audit, ids: ctx.ids, clock: ctx.clock },
      actor: principalId === null ? null : { principalId },
      tokenId: null,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    },
    action,
    { type: "telegram", id: principalId },
    outcome,
    reason,
  );
}

/**
 * How long a link stays usable.
 *
 * Ten minutes: long enough to switch to a phone, unlock it and press start; short enough that
 * one left in a browser history or a screenshot is worthless. This is a credential that binds
 * a chat to an account, so its lifetime is the window in which a stolen copy works.
 */
export const LINK_TTL_MS = 10 * 60 * 1000;

/** Crockford-ish, from the platform's own alphabet: unguessable and safe in a URL. */
const NONCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newNonce(random: Uint8Array): string {
  return [...random].map((byte) => NONCE_ALPHABET[byte % NONCE_ALPHABET.length]).join("");
}

export interface StartedLink {
  nonce: string;
  expiresAt: string;
  /** What the page shows. The bot name comes from configuration, never from a request. */
  url: string;
}

/**
 * Issues a link for a signed-in person (SPEC §9.3).
 *
 * Any previous unused nonce for this principal stays valid until it expires. Invalidating it
 * would be tidier and would break the ordinary case: somebody opens the page on a laptop,
 * loses patience, opens it again, and then presses the first link on their phone.
 */
export async function startTelegramLink(
  ctx: TelegramContext,
  principalId: string,
  options: { botUsername: string; random: Uint8Array },
): Promise<Result<StartedLink>> {
  const now = ctx.clock.now();
  const nonce = newNonce(options.random);
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();

  await ctx.db.commit([
    ctx.telegram.insertLink({
      nonce,
      principalId: principalId as OratorId,
      createdAt: now.toISOString(),
      expiresAt,
    }),
    // The row records that a credential was *issued*, which is the half an account holder
    // can check: a nonce nobody asked for is somebody with a session they did not open.
    journalTelegram(ctx, "telegram.link.issued", principalId, "success", null),
  ]);

  return ok({
    nonce,
    expiresAt,
    url: `https://t.me/${options.botUsername}?start=${nonce}`,
  });
}

export interface RedeemInput {
  nonce: string;
  telegramUserId: string;
  chatId: string;
  username?: string | null;
}

/**
 * Redeems a nonce, binding the chat to the principal that issued it (SPEC §9.3).
 *
 * Every failure here answers the same way to the chat — "that link is not usable" — but they
 * are distinguished in the result because the operator's log should say which: an expired
 * link is an ordinary thing that happens to honest people, and a nonce that never existed is
 * somebody guessing.
 */
export async function redeemTelegramLink(
  ctx: TelegramContext,
  input: RedeemInput,
): Promise<Result<TelegramAccount>> {
  /*
   * A refusal is written down as well as answered (SPEC §62).
   *
   * Its own commit rather than a batch, because there is no domain write to join: nothing
   * changed, and what is worth keeping is that somebody presented a nonce and was told no.
   * Repeated rows naming no principal are the shape of a guesser, which is exactly the
   * question an audit log is asked afterwards and the Worker's log cannot answer.
   */
  const refuse = async (
    principalId: string | null,
    reason: string,
    error: Result<TelegramAccount>,
  ): Promise<Result<TelegramAccount>> => {
    await ctx.db.commit([journalTelegram(ctx, "telegram.linked", principalId, "denied", reason)]);
    return error;
  };

  const link: TelegramLink | null = await ctx.telegram.findLink(input.nonce);
  if (link === null) return refuse(null, "unknown-nonce", fail(ErrorType.NotFound, "No such link"));

  const now = ctx.clock.now();
  if (link.usedAt !== null) {
    return refuse(
      link.principalId,
      "already-used",
      fail(ErrorType.Conflict, "That link has been used already"),
    );
  }
  if (Date.parse(link.expiresAt) <= now.getTime()) {
    return refuse(link.principalId, "expired", fail(ErrorType.Conflict, "That link has expired"));
  }

  /*
   * §9.3 — one Telegram account, one principal.
   *
   * Checked before the write rather than left to the unique index, so the answer in the chat
   * can say what happened. A person who linked an old account and is now linking a new one
   * has to unlink first, and being told that is the difference between a rule and a failure.
   */
  const existing = await ctx.telegram.findByTelegramUser(input.telegramUserId);
  if (existing !== null && existing.principalId !== link.principalId) {
    return refuse(
      link.principalId,
      "telegram-account-taken",
      fail(
        ErrorType.Conflict,
        "That Telegram account is already connected to another account",
        "Disconnect it there first. One Telegram account belongs to one principal (§9.3).",
      ),
    );
  }

  const account: TelegramAccount = {
    principalId: link.principalId,
    telegramUserId: input.telegramUserId,
    chatId: input.chatId,
    username: input.username ?? null,
    linkedAt: now.toISOString(),
    // A fresh binding is a working channel: the upsert clears any block on the old one.
    unavailableSince: null,
  };

  await ctx.db.commit([
    ctx.telegram.upsertAccount(account),
    // Marked used in the same transaction as the binding: apart, a crash between them leaves
    // a nonce that can bind a second chat to the same account.
    ctx.telegram.markLinkUsed(input.nonce, now.toISOString()),
    journalTelegram(ctx, "telegram.linked", link.principalId, "success", null),
  ]);

  return ok(account);
}

/**
 * A one-time link that opens a session, sent into the chat that already belongs to the
 * account (SPEC §9.3, §9.1).
 *
 * This is the recovery path §9 asks for, and the reason it is safe is the binding: the chat
 * was connected by somebody who was signed in, so a message arriving from it is a message
 * from that account's owner. The link is what an email magic link would be, on a channel that
 * is already authenticated and that delivers in a second.
 *
 * **Ten minutes, and once, and spent by pressing rather than by opening.** Two minutes was
 * the first answer and it was the wrong axis: the risk is not how long the link lives, it is
 * what can spend it. A chat message is fetched by Telegram to build a preview, by link
 * scanners, by whatever else reads a URL on its way to a person — so the site asks for a
 * press, and a fetch of the address does nothing. With that, a humane window costs nothing:
 * somebody switching to another device has time to get there.
 */
export const LOGIN_TTL_MS = 10 * 60 * 1000;

export interface StartedLogin {
  nonce: string;
  url: string;
  expiresAt: string;
}

export async function startTelegramLogin(
  ctx: TelegramContext,
  telegramUserId: string,
  options: { siteOrigin: string; random: Uint8Array },
): Promise<Result<StartedLogin>> {
  /*
   * The account comes from the binding, never from the message.
   *
   * Everything a chat says about itself is a claim; the one thing that is not is which
   * principal it was bound to, because that was recorded by a signed-in browser (§9.3).
   */
  const account = await ctx.telegram.findByTelegramUser(telegramUserId);
  if (account === null) {
    /*
     * Recorded although it names nobody, and that is what makes it worth recording.
     *
     * `/login` from an unconnected chat is ordinarily somebody who found the bot. Many of
     * them, from many chats, is somebody looking for a chat that answers — and no other
     * store keeps that for longer than the Worker's log retains a line.
     */
    await ctx.db.commit([
      journalTelegram(ctx, "telegram.login.issued", null, "denied", "chat-not-connected"),
    ]);
    return fail(ErrorType.NotFound, "This chat is not connected to an account");
  }

  const now = ctx.clock.now();
  const nonce = newNonce(options.random);
  const expiresAt = new Date(now.getTime() + LOGIN_TTL_MS).toISOString();

  await ctx.db.commit([
    ctx.telegram.insertLogin({
      nonce,
      principalId: account.principalId,
      chatId: account.chatId,
      createdAt: now.toISOString(),
      expiresAt,
    }),
    // A credential that opens a session, so the issue is a §62 event in its own right: this
    // row and the one below it are how an account holder sees a sign-in they did not make.
    journalTelegram(ctx, "telegram.login.issued", account.principalId, "success", null),
  ]);

  return ok({ nonce, expiresAt, url: `${options.siteOrigin}/auth/telegram?token=${nonce}` });
}

/**
 * Spends the nonce, and answers with the principal it belongs to (SPEC §9.1, §9.3).
 *
 * The caller opens the session, because that is `auth.ts`'s business and this module has no
 * sessions repository — which is also what stops this service from being able to sign anybody
 * in on its own.
 */
export async function redeemTelegramLogin(
  ctx: TelegramContext,
  nonce: string,
): Promise<Result<{ principalId: OratorId }>> {
  const login = await ctx.telegram.findLogin(nonce);
  /*
   * One answer for every failure, and a row that distinguishes them.
   *
   * A link that never existed and one used a minute ago are the same fact to whoever is
   * holding it — telling them apart tells a guesser which guesses are close. The audit log
   * is the opposite audience: it is read by the person whose account it is and by whoever
   * answers "was this account attacked", and to them the reason is the whole content.
   */
  const refuse = async (principalId: string | null, reason: string) => {
    await ctx.db.commit([journalTelegram(ctx, "telegram.login.used", principalId, "denied", reason)]);
    return fail(ErrorType.NotFound, "That link is not usable") as Result<{ principalId: OratorId }>;
  };
  if (login === null) return refuse(null, "unknown-nonce");

  const now = ctx.clock.now();
  if (login.usedAt !== null) return refuse(login.principalId, "already-used");
  if (Date.parse(login.expiresAt) <= now.getTime()) return refuse(login.principalId, "expired");

  const [spent] = await ctx.db.commit([ctx.telegram.markLoginUsed(nonce, now.toISOString())]);
  /*
   * The write is the guard, not the read above.
   *
   * Two browsers opening the same link at once both pass the checks; only one of them
   * updates a row, and the other is refused. Checking without writing would sign both in.
   *
   * Which is why the audit row is not in that batch: the outcome is decided by what the
   * statement changed, and a row written alongside it would have to claim an outcome before
   * it is known. A crash between the two loses the record of a sign-in and never the record
   * of one that did not happen — the session is opened by the caller, after this returns.
   */
  if ((spent?.changes ?? 0) === 0) return refuse(login.principalId, "lost-the-race");

  await ctx.db.commit([
    journalTelegram(ctx, "telegram.login.used", login.principalId, "success", null),
  ]);

  return ok({ principalId: login.principalId });
}

/**
 * Takes spent login links out of the chats they were sent to (SPEC §9.3).
 *
 * Housekeeping rather than security: the link stopped working when it was pressed. What it
 * fixes is a message that still says "press this to sign in" long after it will do anything,
 * which invites a second press and reads, to anybody glancing at the screen, as a live
 * credential.
 *
 * Done from the schedule rather than at the moment of use, and that is not laziness: the
 * press happens in a browser, and the browser has no bot token — §57.5 keeps that credential
 * in the one Worker that needs it. So the sign-in records the fact and the minute cron acts
 * on it, which is a minute of a dead link remaining and no credential in a second place.
 *
 * The deletion is asked for once: `cleaned_at` is written whether Telegram accepted or not,
 * because a message somebody deleted themselves, or one older than Telegram's 48-hour window,
 * will never be deletable and retrying it forever is a queue that never drains.
 */
export async function cleanSpentLogins(
  ports: TelegramPorts,
  remove: (chatId: string, messageId: string) => Promise<void>,
  limit = 20,
): Promise<number> {
  const spent = await ports.telegram.listSpentLoginMessages(limit);
  const now = ports.clock.now().toISOString();

  for (const login of spent) {
    try {
      await remove(login.chatId, login.messageId);
    } catch {
      // Nothing: the row is marked either way, for the reason above.
    }
    await ports.db.commit([ports.telegram.markLoginCleaned(login.nonce, now)]);
  }

  return spent.length;
}

/**
 * SPEC §9.3, §23.5 — disconnecting, which is the first thing a person needs when a device
 * changes hands.
 *
 * `from` is recorded rather than inferred, and the two are not interchangeable: a page can
 * only be reached by somebody holding a session, and a chat can be reached by whoever holds
 * the phone. An account that loses its recovery channel should be able to see which.
 */
export async function unlinkTelegram(
  ctx: TelegramContext,
  principalId: string,
  from: "chat" | "settings",
): Promise<Result<true>> {
  await ctx.db.commit([
    ctx.telegram.deleteAccount(principalId),
    journalTelegram(ctx, "telegram.unlinked", principalId, "success", `from=${from}`),
  ]);
  return ok(true);
}

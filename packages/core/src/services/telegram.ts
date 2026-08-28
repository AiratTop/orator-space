import { ErrorType } from "@orator/protocol";
import type { OratorId } from "@orator/protocol";
import type { TelegramAccount, TelegramLink, TelegramRepo } from "../ports/index.js";
import { fail, ok, type Ports, type Result } from "./context.js";

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
  ports: TelegramPorts,
  principalId: string,
  options: { botUsername: string; random: Uint8Array },
): Promise<Result<StartedLink>> {
  const now = ports.clock.now();
  const nonce = newNonce(options.random);
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();

  await ports.db.commit([
    ports.telegram.insertLink({
      nonce,
      principalId: principalId as OratorId,
      createdAt: now.toISOString(),
      expiresAt,
    }),
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
  ports: TelegramPorts,
  input: RedeemInput,
): Promise<Result<TelegramAccount>> {
  const link: TelegramLink | null = await ports.telegram.findLink(input.nonce);
  if (link === null) return fail(ErrorType.NotFound, "No such link");

  const now = ports.clock.now();
  if (link.usedAt !== null) return fail(ErrorType.Conflict, "That link has been used already");
  if (Date.parse(link.expiresAt) <= now.getTime()) {
    return fail(ErrorType.Conflict, "That link has expired");
  }

  /*
   * §9.3 — one Telegram account, one principal.
   *
   * Checked before the write rather than left to the unique index, so the answer in the chat
   * can say what happened. A person who linked an old account and is now linking a new one
   * has to unlink first, and being told that is the difference between a rule and a failure.
   */
  const existing = await ports.telegram.findByTelegramUser(input.telegramUserId);
  if (existing !== null && existing.principalId !== link.principalId) {
    return fail(
      ErrorType.Conflict,
      "That Telegram account is already connected to another account",
      "Disconnect it there first. One Telegram account belongs to one principal (§9.3).",
    );
  }

  const account: TelegramAccount = {
    principalId: link.principalId,
    telegramUserId: input.telegramUserId,
    chatId: input.chatId,
    username: input.username ?? null,
    linkedAt: now.toISOString(),
  };

  await ports.db.commit([
    ports.telegram.upsertAccount(account),
    // Marked used in the same transaction as the binding: apart, a crash between them leaves
    // a nonce that can bind a second chat to the same account.
    ports.telegram.markLinkUsed(input.nonce, now.toISOString()),
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
  ports: TelegramPorts,
  telegramUserId: string,
  options: { siteOrigin: string; random: Uint8Array },
): Promise<Result<StartedLogin>> {
  /*
   * The account comes from the binding, never from the message.
   *
   * Everything a chat says about itself is a claim; the one thing that is not is which
   * principal it was bound to, because that was recorded by a signed-in browser (§9.3).
   */
  const account = await ports.telegram.findByTelegramUser(telegramUserId);
  if (account === null) return fail(ErrorType.NotFound, "This chat is not connected to an account");

  const now = ports.clock.now();
  const nonce = newNonce(options.random);
  const expiresAt = new Date(now.getTime() + LOGIN_TTL_MS).toISOString();

  await ports.db.commit([
    ports.telegram.insertLogin({
      nonce,
      principalId: account.principalId,
      chatId: account.chatId,
      createdAt: now.toISOString(),
      expiresAt,
    }),
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
  ports: TelegramPorts,
  nonce: string,
): Promise<Result<{ principalId: OratorId }>> {
  const login = await ports.telegram.findLogin(nonce);
  // One answer for every failure: a link that never existed and one used a minute ago are
  // the same fact to whoever is holding it, and telling them apart is telling them which
  // guesses are close.
  const refuse = () => fail(ErrorType.NotFound, "That link is not usable");
  if (login === null) return refuse();

  const now = ports.clock.now();
  if (login.usedAt !== null) return refuse();
  if (Date.parse(login.expiresAt) <= now.getTime()) return refuse();

  const [spent] = await ports.db.commit([ports.telegram.markLoginUsed(nonce, now.toISOString())]);
  /*
   * The write is the guard, not the read above.
   *
   * Two browsers opening the same link at once both pass the checks; only one of them
   * updates a row, and the other is refused. Checking without writing would sign both in.
   */
  if ((spent?.changes ?? 0) === 0) return refuse();

  return ok({ principalId: login.principalId });
}

/** SPEC §9.3, §23.5 — disconnecting, which is the first thing a person needs when a device changes hands. */
export async function unlinkTelegram(ports: TelegramPorts, principalId: string): Promise<Result<true>> {
  await ports.db.commit([ports.telegram.deleteAccount(principalId)]);
  return ok(true);
}

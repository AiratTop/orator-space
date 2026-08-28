import type { APIRoute } from "astro";
import { openSessionFor, redeemTelegramLogin } from "@orator/core";
import { authContext, sessionCookie } from "../../lib/auth.js";
import { telegramPorts } from "../../lib/account.js";

/**
 * Signing in from the chat (SPEC §9.3, §9.1).
 *
 * The end of the link `/login` sends. Everything that decides who this is happened already:
 * the chat was bound by somebody who was signed in (§9.3), and the nonce was issued to that
 * binding. This spends it and opens a session.
 *
 * **A GET that changes state, which is normally a mistake and is not one here.** The person
 * is arriving from another application by pressing a link; there is no page to post from.
 * What makes it safe is that the token is single-use and short-lived: a prefetch spends it
 * and the person is told to ask again, which is a nuisance rather than a vulnerability. The
 * alternative — a page with a button — puts a credential in a browser's history and address
 * bar for the length of a decision instead of the length of a redirect.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const token = url.searchParams.get("token") ?? "";

  const refuse = () =>
    new Response(null, {
      status: 303,
      headers: { location: "/signin?telegram=expired", "cache-control": "private, no-store" },
    });

  if (!/^[0-9A-Z]{8,64}$/.test(token)) return refuse();

  const redeemed = await redeemTelegramLogin(telegramPorts, token);
  if (!redeemed.ok) return refuse();

  const opened = await openSessionFor(
    authContext(request, crypto.randomUUID()),
    redeemed.value.principalId,
  );
  if (!opened.ok) return refuse();

  /*
   * Straight to the account, and the cookie is set on the redirect.
   *
   * The token is in the URL of the request that just spent it, so the response must not be
   * a page: a reload would re-send a credential that no longer works, and the address would
   * sit in history looking like one that does.
   */
  return new Response(null, {
    status: 303,
    headers: {
      location: "/settings?tab=telegram",
      "set-cookie": sessionCookie(opened.value.sessionToken),
      "cache-control": "private, no-store",
    },
  });
};

import type { APIRoute } from "astro";
import { beginPasskeyRegistration, bearerFrom, identify, sealChallenge } from "@orator/core";
import {
  authContext,
  authPorts,
  authProblem,
  challengeCookie,
  readCookie,
  SESSION_COOKIE,
  signingSecret,
} from "../../../lib/auth.js";

/**
 * Adding a passkey to an established identity (SPEC §42.2).
 *
 * An existing credential is required, and the endpoint never takes a principal id from the
 * caller: one that did would be a way to take over any account by naming it.
 *
 * Either credential will do — a session cookie, or the API token registration returned.
 * The token has to be accepted, because otherwise the flow has no beginning: a person who
 * has just registered holds a token and nothing else, and needs a passkey to get a session.
 * That is the same dead end §42.2 was written to close, one step further along.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = signingSecret();
  if (secret === null) return authProblem(503, "Sign-in is not configured", "SESSION_SECRET is not set.");

  const session = await identify(authPorts, {
    sessionCookie: readCookie(request, SESSION_COOKIE),
    bearerToken: bearerFrom(request.headers.get("authorization")),
  });
  if (session === null) {
    return authProblem(
      401,
      "Sign in first",
      "Send a session cookie, or the API token registration returned — a new account has no session yet (§42.2).",
    );
  }

  const result = await beginPasskeyRegistration(authContext(request, "web"), session.principalId);
  if (!result.ok) return authProblem(403, result.error.title, result.error.detail);

  const sealed = await sealChallenge(secret, result.value.challenge, Date.now());
  return new Response(JSON.stringify(result.value), {
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "set-cookie": challengeCookie(sealed),
    },
  });
};

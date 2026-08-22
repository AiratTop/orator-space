import type { APIRoute } from "astro";
import { beginPasskeyRegistration, resolveSession } from "@orator/core";
import {
  authContext,
  authPorts,
  authProblem,
  challengeCookie,
  readCookie,
  sealChallenge,
  SESSION_COOKIE,
  signingSecret,
} from "../../../lib/auth.js";

/**
 * Adding a passkey to an account that is already signed in.
 *
 * Registration requires an existing session on purpose: a passkey is a credential for an
 * account, and an endpoint that attached one to an arbitrary principal id would be a way to
 * take over any account by naming it.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = signingSecret();
  if (secret === null) return authProblem(503, "Sign-in is not configured", "SESSION_SECRET is not set.");

  const cookie = readCookie(request, SESSION_COOKIE);
  const session = cookie === null ? null : await resolveSession(authPorts, cookie);
  if (session === null) return authProblem(401, "Sign in first");

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

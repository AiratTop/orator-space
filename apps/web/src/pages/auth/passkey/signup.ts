import type { APIRoute } from "astro";
import { completeSignup, openChallenge } from "@orator/core";
import {
  authContext,
  authProblem,
  CHALLENGE_COOKIE,
  clearedChallengeCookie,
  readCookie,
  sessionCookie,
  signingSecret,
  unpackSignup,
} from "../../../lib/auth.js";

/**
 * Step two: the passkey is verified and the account comes into existence (SPEC §9, §7.3).
 *
 * Everything is written here or nothing is — the principal, the human account, the credential
 * and the session in one commit. Until this request succeeds there is no account, which is
 * what makes a cancelled ceremony free rather than permanent.
 *
 * Who the account is for comes out of the signed cookie, never out of the body. A caller
 * that could name its own principal id would be naming somebody else's.
 *
 * The challenge cookie is cleared in every branch, success or failure, exactly as sign-in
 * clears it: leaving it after a failed attempt widens the replay window for no reason.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = signingSecret();
  if (secret === null) return authProblem(503, "Sign-in is not configured", "SESSION_SECRET is not set.");

  const payload = await openChallenge(secret, readCookie(request, CHALLENGE_COOKIE), Date.now());
  if (payload === null) {
    return withCleared(authProblem(400, "The challenge is missing or expired. Start again."));
  }

  const pending = unpackSignup(payload);
  if (pending === null) {
    // A sealed challenge that is not a signup's. Signing in and signing up share the cookie
    // name and the envelope, and the two ceremonies must not be completable with each
    // other's.
    return withCleared(authProblem(400, "That challenge does not belong to a sign-up. Start again."));
  }

  const body = (await request.json().catch(() => null)) as { credential?: unknown; display_name?: unknown } | null;
  if (body === null || body.credential === undefined) return withCleared(authProblem(400, "Malformed request"));

  const result = await completeSignup(authContext(request, "web"), {
    principalId: pending.principalId,
    username: pending.username,
    displayName: typeof body.display_name === "string" ? body.display_name : null,
    challenge: pending.challenge,
    response: body.credential,
  });

  if (!result.ok) {
    const status = result.error.type === "conflict" ? 409 : 400;
    return withCleared(authProblem(status, result.error.title, result.error.detail ?? undefined));
  }

  const response = new Response(
    JSON.stringify({ username: result.value.username, expires_at: result.value.expiresAt }),
    { headers: { "content-type": "application/json", "cache-control": "private, no-store" } },
  );
  response.headers.append("set-cookie", clearedChallengeCookie());
  response.headers.append("set-cookie", sessionCookie(result.value.sessionToken));
  return response;
};

function withCleared(response: Response): Response {
  response.headers.append("set-cookie", clearedChallengeCookie());
  return response;
}

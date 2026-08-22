import type { APIRoute } from "astro";
import { completePasskeyAuthentication, openChallenge } from "@orator/core";
import {
  authContext,
  authProblem,
  CHALLENGE_COOKIE,
  clearedChallengeCookie,
  readCookie,
  sessionCookie,
  signingSecret,
} from "../../../lib/auth.js";

/**
 * Step two: the assertion is verified and a session begins (SPEC §9.1).
 *
 * The challenge cookie is cleared in every branch, success or failure. Leaving it in place
 * after a failed attempt would widen the replay window for no reason, and ADR 0004's whole
 * argument for keeping the challenge in a cookie rests on that window being short.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = signingSecret();
  if (secret === null) return authProblem(503, "Sign-in is not configured", "SESSION_SECRET is not set.");

  const challenge = await openChallenge(secret, readCookie(request, CHALLENGE_COOKIE), Date.now());
  if (challenge === null) {
    return withCleared(authProblem(401, "Could not sign in", "The challenge is missing or expired. Start again."));
  }

  const body = await request.json().catch(() => null);
  if (body === null) return withCleared(authProblem(400, "Malformed request"));

  const result = await completePasskeyAuthentication(authContext(request, "web"), {
    challenge,
    response: body,
  });
  if (!result.ok) return withCleared(authProblem(401, "Could not sign in"));

  const response = new Response(
    JSON.stringify({ username: result.value.username, expires_at: result.value.expiresAt }),
    { headers: { "content-type": "application/json", "cache-control": "private, no-store" } },
  );
  response.headers.append("set-cookie", sessionCookie(result.value.sessionToken));
  response.headers.append("set-cookie", clearedChallengeCookie());
  return response;
};

function withCleared(response: Response): Response {
  response.headers.append("set-cookie", clearedChallengeCookie());
  return response;
}

import type { APIRoute } from "astro";
import { completePasskeyRegistration, resolveSession } from "@orator/core";
import {
  authContext,
  authPorts,
  authProblem,
  CHALLENGE_COOKIE,
  clearedChallengeCookie,
  openChallenge,
  readCookie,
  SESSION_COOKIE,
  signingSecret,
} from "../../../lib/auth.js";

export const POST: APIRoute = async ({ request }) => {
  const secret = signingSecret();
  if (secret === null) return authProblem(503, "Sign-in is not configured", "SESSION_SECRET is not set.");

  const cookie = readCookie(request, SESSION_COOKIE);
  const session = cookie === null ? null : await resolveSession(authPorts, cookie);
  if (session === null) return authProblem(401, "Sign in first");

  const challenge = await openChallenge(secret, readCookie(request, CHALLENGE_COOKIE), Date.now());
  if (challenge === null) return authProblem(400, "The challenge is missing or expired. Start again.");

  const body = await request.json().catch(() => null);
  if (body === null) return authProblem(400, "Malformed request");

  const result = await completePasskeyRegistration(authContext(request, "web"), {
    principalId: session.principalId,
    challenge,
    response: body,
  });

  const response = result.ok
    ? new Response(JSON.stringify({ id: result.value.id }), {
        status: 201,
        headers: { "content-type": "application/json", "cache-control": "private, no-store" },
      })
    : authProblem(400, result.error.title, result.error.detail);

  response.headers.append("set-cookie", clearedChallengeCookie());
  return response;
};

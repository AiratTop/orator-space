import type { APIRoute } from "astro";
import { beginPasskeyAuthentication } from "@orator/core";
import { authContext, authProblem, challengeCookie, sealChallenge, signingSecret } from "../../../lib/auth.js";

/**
 * Step one of signing in (SPEC §42.2, ADR 0004).
 *
 * Asks for no username. The credential is discoverable, so the authenticator already knows
 * which passkey belongs to this site — which means this endpoint tells an anonymous caller
 * nothing about who is registered here.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = signingSecret();
  if (secret === null) return authProblem(503, "Sign-in is not configured", "SESSION_SECRET is not set.");

  const options = await beginPasskeyAuthentication(authContext(request, "web"));
  const sealed = await sealChallenge(secret, options.challenge, Date.now());

  return new Response(JSON.stringify(options), {
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "set-cookie": challengeCookie(sealed),
    },
  });
};

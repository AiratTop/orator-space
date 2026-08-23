import type { APIRoute } from "astro";
import { beginSignup, sealChallenge } from "@orator/core";
import {
  authContext,
  authProblem,
  challengeCookie,
  packSignup,
  signingSecret,
} from "../../../lib/auth.js";

/**
 * Step one of creating an account (SPEC §9, §42.2, §7.3).
 *
 * Anonymous, and it writes nothing. It checks that the name is free, mints the id the
 * ceremony will use as its WebAuthn user handle, and seals both into the challenge cookie —
 * so a cancelled ceremony leaves no principal and, more importantly, burns no username.
 * §7.3 never reassigns one, which makes "created the account, then failed to attach a
 * passkey" a permanent loss rather than a retry.
 *
 * The username's fate is decided here in words a person can act on: taken, confusable with
 * an existing one (§7.3), or malformed. That is the whole reason signing up needs a form and
 * signing in does not.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = signingSecret();
  if (secret === null) return authProblem(503, "Sign-in is not configured", "SESSION_SECRET is not set.");

  const body = (await request.json().catch(() => null)) as
    | { username?: unknown; display_name?: unknown }
    | null;
  if (body === null || typeof body.username !== "string") {
    return authProblem(400, "A username is required");
  }

  const started = await beginSignup(authContext(request, "web"), {
    username: body.username,
    displayName: typeof body.display_name === "string" ? body.display_name : null,
  });
  if (!started.ok) {
    // The domain's own words: "taken", "too similar to an existing one", or why the name is
    // not a name. A form that said "invalid" instead would leave a person guessing.
    const status = started.error.type === "conflict" ? 409 : 400;
    return authProblem(status, started.error.title, started.error.detail ?? undefined);
  }

  const sealed = await sealChallenge(
    secret,
    packSignup(started.value.options.challenge, started.value.principalId, started.value.username),
    Date.now(),
  );

  return new Response(JSON.stringify(started.value.options), {
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "set-cookie": challengeCookie(sealed),
    },
  });
};

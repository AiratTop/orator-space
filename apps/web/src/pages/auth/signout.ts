import type { APIRoute } from "astro";
import { signOut } from "@orator/core";
import { authPorts, clearedSessionCookie, readCookie, SESSION_COOKIE } from "../../lib/auth.js";

/**
 * Ends a session.
 *
 * POST rather than GET: a link a browser can follow means any page on the internet can
 * sign a reader out by embedding an image. The cookie is cleared even when the session was
 * already unknown, so a stale cookie cannot survive a deliberate sign-out.
 */
export const POST: APIRoute = async ({ request }) => {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie !== null) await signOut(authPorts, cookie);

  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": clearedSessionCookie(), "cache-control": "private, no-store" },
  });
};

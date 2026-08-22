import { env } from "cloudflare:workers";
import {
  createCredentialRepo,
  createD1Database,
  createIdGen,
  createPasskeyVerifier,
  createPrincipalRepo,
  createSessionRepo,
  systemClock,
} from "@orator/adapters-cf";
import { CHALLENGE_LIFETIME_MS, SESSION_LIFETIME_MS, type AuthContext, type AuthPorts } from "@orator/core";
import { siteHost, siteOrigin } from "./ports.js";

/**
 * Passkey sign-in on the web surface (SPEC §9.1, §42.2, ADR 0004).
 *
 * On the web and not on the API, and that placement is the requirement rather than a
 * convenience. §9.1 forbids `api.orator.space` accepting a session because a browser
 * attaches a cookie automatically, which makes every mutating endpoint CSRF-able. A cookie
 * issued here is scoped to this hostname and the API never reads it.
 */

interface AuthEnv {
  DB: D1Database;
  ENVIRONMENT: string;
  /** Signs the challenge cookie. Set with `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET?: string;
}

const authEnv = env as unknown as AuthEnv;

const idGen = createIdGen();

export const authPorts: AuthPorts = {
  db: createD1Database(authEnv.DB),
  principals: createPrincipalRepo(authEnv.DB),
  credentials: createCredentialRepo(authEnv.DB),
  sessions: createSessionRepo(authEnv.DB),
  passkeys: createPasskeyVerifier(),
  clock: systemClock,
  ids: idGen,
};

/**
 * The signing secret, or null.
 *
 * Null is not a fallback. A deployment without the secret refuses to sign anyone in rather
 * than signing them in with a known key — a default secret is the kind of thing that works
 * perfectly in every environment including the one it should not.
 */
export function signingSecret(): string | null {
  const configured = authEnv.SESSION_SECRET;
  if (configured !== undefined && configured.length >= 32) return configured;
  if (authEnv.ENVIRONMENT === "local") return "local-development-secret-not-for-any-deployment";
  return null;
}

export const SESSION_COOKIE = "orator_session";
export const CHALLENGE_COOKIE = "orator_challenge";

export function authContext(request: Request, requestId: string): AuthContext {
  return {
    ports: authPorts,
    requestId,
    // The relying party is the hostname, and it comes from configuration rather than from
    // the request: an rpId taken from a header is an rpId an attacker chooses.
    rpId: siteHost,
    rpName: "Orator.Space",
    origin: siteOrigin,
    userAgent: request.headers.get("user-agent"),
    ipHash: null,
  };
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

const secure = (host: string) => (host === "localhost" ? "" : "; Secure");

export const sessionCookie = (value: string, maxAgeMs = SESSION_LIFETIME_MS): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly${secure(siteHost)}; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;

export const clearedSessionCookie = (): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly${secure(siteHost)}; SameSite=Lax; Max-Age=0`;

/**
 * The challenge cookie (ADR 0004).
 *
 * `SameSite=Strict` rather than `Lax`: nothing legitimate arrives at a WebAuthn ceremony
 * from another site, and the whole value of the challenge is that an attacker cannot
 * choose it. Five minutes, because a ceremony a person is actually performing takes
 * seconds and anything longer is only a wider replay window.
 */
export const challengeCookie = (value: string): string =>
  `${CHALLENGE_COOKIE}=${encodeURIComponent(value)}; Path=/auth; HttpOnly${secure(siteHost)}; SameSite=Strict; Max-Age=${Math.floor(CHALLENGE_LIFETIME_MS / 1000)}`;

export const clearedChallengeCookie = (): string =>
  `${CHALLENGE_COOKIE}=; Path=/auth; HttpOnly${secure(siteHost)}; SameSite=Strict; Max-Age=0`;

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `challenge.expiry.mac` — enough to verify without storing anything. */
export async function sealChallenge(secret: string, challenge: string, now: number): Promise<string> {
  const expiry = now + CHALLENGE_LIFETIME_MS;
  const payload = `${challenge}.${expiry}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

/** Returns the challenge, or null if it is missing, tampered with, or past its expiry. */
export async function openChallenge(secret: string, sealed: string | null, now: number): Promise<string | null> {
  if (sealed === null) return null;
  const parts = sealed.split(".");
  if (parts.length !== 3) return null;
  const [challenge, expiry, mac] = parts as [string, string, string];

  const expected = await hmac(secret, `${challenge}.${expiry}`);
  // Length-safe comparison. The values are short and the timing signal is weak, but a
  // constant-time compare costs one loop and removes the question.
  if (expected.length !== mac.length) return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
  if (difference !== 0) return null;

  const deadline = Number(expiry);
  if (!Number.isFinite(deadline) || deadline <= now) return null;
  return challenge;
}

/** SPEC §45 — the auth endpoints answer in problem documents like everything else. */
export const authProblem = (status: number, title: string, detail?: string): Response =>
  new Response(
    JSON.stringify({
      type: `https://orator.space/errors/${status === 401 ? "unauthenticated" : status === 503 ? "unavailable" : "validation-failed"}`,
      title,
      status,
      ...(detail === undefined ? {} : { detail }),
    }),
    { status, headers: { "content-type": "application/problem+json", "cache-control": "private, no-store" } },
  );

import { ErrorType, type OratorId } from "@orator/protocol";
import { generateSessionToken, sha256Hex } from "../identity/tokens.js";
import type {
  AuthenticationOptions,
  Clock,
  CredentialRepo,
  Database,
  IdGen,
  PasskeyVerifier,
  PrincipalRepo,
  RegistrationOptions,
  SessionRepo,
} from "../ports/index.js";
import { fail, ok, type Result } from "./context.js";

/**
 * Passkey sign-in and browser sessions (SPEC §42.2, §9.1, ADR 0004).
 *
 * Separate from `identity.ts` on purpose. That module issues API tokens — a credential a
 * program holds and sends deliberately. This one issues a cookie, which a browser attaches
 * on its own, and the two must never be interchangeable: §9.1 forbids the API accepting a
 * session precisely because automatic attachment is what makes CSRF possible.
 */

/** Everything this flow may touch. Narrower than `Ports`: it publishes nothing. */
export interface AuthPorts {
  db: Database;
  principals: PrincipalRepo;
  credentials: CredentialRepo;
  sessions: SessionRepo;
  passkeys: PasskeyVerifier;
  clock: Clock;
  ids: IdGen;
}

export interface AuthContext {
  ports: AuthPorts;
  requestId: string;
  rpId: string;
  rpName: string;
  origin: string;
  userAgent: string | null;
  ipHash: string | null;
}

/** SPEC §9.1 — long enough to be usable, short enough that a stolen cookie expires. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function beginPasskeyRegistration(
  ctx: AuthContext,
  principalId: string,
): Promise<Result<RegistrationOptions>> {
  const principal = await ctx.ports.principals.findById(principalId);
  if (principal === null || principal.status !== "active") {
    return fail(ErrorType.NotFound, "Principal not found");
  }
  if (principal.kind !== "human") {
    // §42.2 — a passkey is how a person proves they are present. An agent proves who it is
    // with a token and proves what it wrote with a signing key (§8.1); neither is this.
    return fail(ErrorType.Forbidden, "Passkeys belong to people", "An agent authenticates with a token.");
  }

  const existing = await ctx.ports.credentials.listFor(principalId);
  const options = await ctx.ports.passkeys.registrationOptions({
    rpId: ctx.rpId,
    rpName: ctx.rpName,
    principalId,
    username: principal.username,
    displayName: principal.displayName ?? principal.username,
    existing: existing.map((credential) => credential.credentialId),
  });

  return ok(options);
}

export async function completePasskeyRegistration(
  ctx: AuthContext,
  input: { principalId: string; challenge: string; response: unknown; label?: string | null },
): Promise<Result<{ id: OratorId; credentialId: string }>> {
  const principal = await ctx.ports.principals.findById(input.principalId);
  if (principal === null || principal.status !== "active") {
    return fail(ErrorType.NotFound, "Principal not found");
  }

  const verified = await ctx.ports.passkeys.verifyRegistration({
    response: input.response,
    expectedChallenge: input.challenge,
    rpId: ctx.rpId,
    origin: ctx.origin,
  });
  if (verified === null) return fail(ErrorType.ValidationFailed, "The passkey could not be verified");

  const existing = await ctx.ports.credentials.findByCredentialId(verified.credentialId);
  if (existing !== null) {
    return fail(ErrorType.Conflict, "That passkey is already registered");
  }

  const id = ctx.ports.ids.next();
  const now = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([
    ctx.ports.credentials.insert({
      id,
      principalId: principal.id,
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      signCount: verified.signCount,
      transports: verified.transports === null ? null : verified.transports.join(","),
      aaguid: verified.aaguid,
      label: input.label ?? null,
      backedUp: verified.backedUp,
      createdAt: now,
    }),
  ]);

  return ok({ id, credentialId: verified.credentialId });
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export async function beginPasskeyAuthentication(ctx: AuthContext): Promise<AuthenticationOptions> {
  // No `allowCredentials`, and no username asked for first. The credential is discoverable
  // (§42.2), so the authenticator knows which one to offer — which means this endpoint
  // reveals nothing about who is registered, to anyone who calls it.
  return ctx.ports.passkeys.authenticationOptions({ rpId: ctx.rpId, allow: [] });
}

export interface SignedIn {
  principalId: OratorId;
  username: string;
  /** The cookie value. Held once, hashed before storage, and never retrievable again. */
  sessionToken: string;
  expiresAt: string;
}

export async function completePasskeyAuthentication(
  ctx: AuthContext,
  input: { challenge: string; response: unknown },
): Promise<Result<SignedIn>> {
  const credentialId = credentialIdOf(input.response);
  if (credentialId === null) return fail(ErrorType.ValidationFailed, "Malformed authentication response");

  const credential = await ctx.ports.credentials.findByCredentialId(credentialId);
  // Indistinguishable from a failed signature on purpose: telling a caller that a
  // credential is unknown turns this endpoint into a way to test whether one exists.
  if (credential === null) return fail(ErrorType.Unauthenticated, "Could not sign in");

  const verified = await ctx.ports.passkeys.verifyAuthentication({
    response: input.response,
    expectedChallenge: input.challenge,
    rpId: ctx.rpId,
    origin: ctx.origin,
    credential: {
      id: credential.credentialId,
      publicKey: credential.publicKey,
      signCount: credential.signCount,
    },
  });
  if (verified === null) return fail(ErrorType.Unauthenticated, "Could not sign in");

  const principal = await ctx.ports.principals.findById(credential.principalId);
  if (principal === null || principal.status !== "active") {
    return fail(ErrorType.Forbidden, "This account is not active");
  }

  const now = ctx.ports.clock.now();
  const token = generateSessionToken();
  const sessionId = ctx.ports.ids.next();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();

  await ctx.ports.db.commit([
    ctx.ports.sessions.insert({
      id: sessionId,
      principalId: principal.id,
      tokenHash: await sha256Hex(token),
      userAgent: ctx.userAgent,
      ipHash: ctx.ipHash,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
    }),
    /**
     * The sign count is stored whether or not it advanced.
     *
     * §42.2 treats a count that fails to advance as the cloned-authenticator signal, and
     * it is a signal rather than a rejection: passkeys synced across a user's devices
     * legitimately report zero forever, so refusing on it would lock out the most common
     * kind of passkey there is. Recorded now, surfaced to moderation later.
     */
    ctx.ports.credentials.recordUse(credential.id, verified.newSignCount, now.toISOString()),
  ]);

  return ok({
    principalId: principal.id,
    username: principal.username,
    sessionToken: token,
    expiresAt,
  });
}

/**
 * Resolves a session cookie.
 *
 * Returns null for anything not currently valid — unknown, revoked or expired — without
 * saying which. The web app treats all three the same way: show the signed-out page.
 */
export async function resolveSession(
  ports: AuthPorts,
  cookieValue: string,
): Promise<{ principalId: OratorId; username: string } | null> {
  const session = await ports.sessions.findByHash(await sha256Hex(cookieValue));
  if (session === null || session.revokedAt !== null) return null;
  if (Date.parse(session.expiresAt) <= ports.clock.now().getTime()) return null;

  const principal = await ports.principals.findById(session.principalId);
  if (principal === null || principal.status !== "active") return null;

  return { principalId: principal.id, username: principal.username };
}

export async function signOut(ports: AuthPorts, cookieValue: string): Promise<void> {
  const session = await ports.sessions.findByHash(await sha256Hex(cookieValue));
  if (session === null) return;
  await ports.db.commit([ports.sessions.revoke(session.id, ports.clock.now().toISOString())]);
}

/** The credential id a browser echoes back, without trusting the rest of the payload yet. */
function credentialIdOf(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= 512 ? id : null;
}

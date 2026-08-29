import { ErrorType, type OratorId } from "@orator/protocol";
import { generateSessionToken, sha256Hex } from "../identity/tokens.js";
import { canonicalizeUsername } from "../identity/username.js";
import { ConstraintViolation } from "../ports/index.js";
import type {
  AuditRepo,
  AuthenticationOptions,
  Clock,
  CredentialRepo,
  Database,
  IdGen,
  PasskeyVerifier,
  PendingWrite,
  PrincipalRepo,
  RegistrationOptions,
  SessionRepo,
  TokenRepo,
} from "../ports/index.js";
import { authenticate } from "./identity.js";
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
  /**
   * SPEC §62 — "key and token operations" includes the key a person signs in with.
   *
   * This flow wrote no audit row at all until §9.2 gained a way to remove a credential, and
   * the asymmetry is what made the absence obvious: removal is recorded, so an account whose
   * credentials had only ever been added had a log that began in the middle. Registering a
   * passkey is the moment a new way into an account comes into existence, which is exactly
   * the class of event §62 exists for.
   */
  audit: AuditRepo;
  /** Read-only, and only to resolve the first token a new account holds (§42.2). */
  tokens: TokenRepo;
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

/**
 * The row that says a new way into an account exists (SPEC §62).
 *
 * In the same commit as the credential, never after it. §35 is the reason and it is not a
 * style preference: a credential that exists with no record of its arrival is precisely the
 * artefact an attacker who registered one would like to leave behind.
 */
function credentialAudit(
  ctx: AuthContext,
  principalId: string,
  credentialId: OratorId,
  at: string,
): PendingWrite {
  return ctx.ports.audit.record({
    id: ctx.ports.ids.next(),
    actorPrincipalId: principalId as OratorId,
    actorTokenId: null,
    action: "credential.registered",
    targetType: "credential",
    targetId: credentialId,
    outcome: "success",
    reason: null,
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    createdAt: at,
  });
}

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
    credentialAudit(ctx, principal.id, id, now),
  ]);

  return ok({ id, credentialId: verified.credentialId });
}

// ---------------------------------------------------------------------------
// Signing up (SPEC §9, §42.2, §7.3)
// ---------------------------------------------------------------------------

/**
 * Creating an account from a browser, in two steps that commit once.
 *
 * The obvious order is to register the principal, hand back a credential, and let the
 * browser add a passkey afterwards — which is what `POST /v1/humans` does, and it is right
 * for the API, where the caller is a program holding a token. From a browser it has two
 * defects, and the second is permanent:
 *
 *   1. The account's first token would land in a page. §9.1 keeps browser credentials and
 *      API tokens apart precisely so a cookie cannot act on the API; a long-lived token in
 *      JavaScript is the same mixing from the other side.
 *   2. A ceremony the person cancels — or their authenticator refuses, or their phone
 *      locks — would leave a principal with no way to sign in, and §7.3 never reassigns a
 *      username. One misfire and the name is gone for good.
 *
 * So nothing is written until there is a verified passkey to write with it. `beginSignup`
 * reserves nothing: it checks the name is free, mints an id to use as the WebAuthn user
 * handle, and returns. `completeSignup` writes the principal, the account, the credential
 * and the session in one commit, or writes nothing at all.
 */
export interface SignupStart {
  /** Minted here and carried through the ceremony as the user handle. Not yet stored. */
  principalId: OratorId;
  username: string;
  options: RegistrationOptions;
}

export async function beginSignup(
  ctx: AuthContext,
  input: { username: string; displayName?: string | null },
): Promise<Result<SignupStart>> {
  const name = canonicalizeUsername(input.username);
  if ("error" in name) {
    return fail(ErrorType.ValidationFailed, "That username will not work", name.error, { field: "username" });
  }

  const taken = await ctx.ports.principals.findByUsername(name.username);
  if (taken !== null) return fail(ErrorType.Conflict, "Username is taken", undefined, { field: "username" });

  const confusable = await ctx.ports.principals.findBySkeleton(name.skeleton);
  if (confusable !== null) {
    // Named explicitly: "taken" would be baffling when the two names look different to the
    // person typing and identical to everyone reading (§7.3).
    return fail(
      ErrorType.Conflict,
      "Username is too similar to an existing one",
      `@${confusable.username} already exists and is visually confusable with this name.`,
      { field: "username", conflicts_with: confusable.username },
    );
  }

  const principalId = ctx.ports.ids.next();
  const displayName = input.displayName?.trim() ?? "";

  const options = await ctx.ports.passkeys.registrationOptions({
    rpId: ctx.rpId,
    rpName: ctx.rpName,
    principalId,
    username: name.username,
    displayName: displayName.length > 0 ? displayName : name.username,
    // Nothing to exclude: this account has no credentials because it does not exist yet.
    // The duplicate is caught on the way back instead, where the credential id is known.
    existing: [],
  });

  return ok({ principalId, username: name.username, options });
}

export async function completeSignup(
  ctx: AuthContext,
  input: {
    principalId: string;
    username: string;
    displayName: string | null;
    challenge: string;
    response: unknown;
  },
): Promise<Result<SignedIn>> {
  /*
   * The name is canonicalised again rather than trusted.
   *
   * What arrives here was sealed by this server minutes ago, so it is not a caller's claim —
   * but it *is* a claim about a moment that has passed, and the check is one string
   * operation. Somebody may have taken the name in between; the unique index below is what
   * actually decides, and this turns that race into a sentence rather than a 500.
   */
  const name = canonicalizeUsername(input.username);
  if ("error" in name) return fail(ErrorType.ValidationFailed, "That username will not work", name.error);

  const verified = await ctx.ports.passkeys.verifyRegistration({
    response: input.response,
    expectedChallenge: input.challenge,
    rpId: ctx.rpId,
    origin: ctx.origin,
  });
  if (verified === null) return fail(ErrorType.ValidationFailed, "The passkey could not be verified");

  /*
   * One passkey, one account.
   *
   * `excludeCredentials` was empty on the way out — there was no account to exclude anything
   * for — so an authenticator holding a passkey for this site will happily mint a second.
   * Refusing here keeps one credential from unlocking two identities, and says the useful
   * thing: the person already has an account and wants the other button.
   */
  const existing = await ctx.ports.credentials.findByCredentialId(verified.credentialId);
  if (existing !== null) {
    return fail(
      ErrorType.Conflict,
      "That passkey already belongs to an account",
      "Sign in with it instead of creating a second account.",
    );
  }

  const now = ctx.ports.clock.now();
  const createdAt = now.toISOString();
  const principalId = input.principalId as OratorId;
  const sessionToken = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
  const displayName = input.displayName?.trim();

  const credentialId = ctx.ports.ids.next();

  try {
    // The whole account, in one commit. A partial one would be an account that exists and
    // cannot be reached, which is the state §7.3 makes permanent.
    await ctx.ports.db.commit([
      ctx.ports.principals.insertPrincipal({
        id: principalId,
        kind: "human",
        username: name.username,
        usernameSkeleton: name.skeleton,
        displayName: displayName !== undefined && displayName.length > 0 ? displayName : null,
        createdAt,
      }),
      // No email. §9.2 signs a person in with a passkey and asks for nothing else; an
      // address collected because a form could is data §23 would then have to protect.
      ctx.ports.principals.insertHumanAccount(principalId, null, createdAt),
      ctx.ports.credentials.insert({
        id: credentialId,
        principalId,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        signCount: verified.signCount,
        transports: verified.transports === null ? null : verified.transports.join(","),
        aaguid: verified.aaguid,
        label: null,
        backedUp: verified.backedUp,
        createdAt,
      }),
      // §62 — the account's first credential is audited like every one after it. The id is
      // minted above rather than inline, because an audit row that names a different id than
      // the row it describes is worse than no audit row.
      credentialAudit(ctx, principalId, credentialId, createdAt),
      ctx.ports.sessions.insert({
        id: ctx.ports.ids.next(),
        principalId,
        tokenHash: await sha256Hex(sessionToken),
        userAgent: ctx.userAgent,
        ipHash: ctx.ipHash,
        createdAt,
        lastSeenAt: createdAt,
        expiresAt,
        revokedAt: null,
      }),
    ]);
  } catch (error) {
    // The check in `beginSignup` narrows the race and cannot close it: uniqueness is the
    // database's to enforce, and two people typing one name reach it together.
    if (error instanceof ConstraintViolation && error.constraint === "unique") {
      return fail(ErrorType.Conflict, "Username is taken", "Somebody registered it while you were deciding.");
    }
    throw error;
  }

  return ok({ principalId, username: name.username, sessionToken, expiresAt });
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
 * Opens a session for a principal whose identity was established elsewhere (SPEC §9.3, §9.1).
 *
 * The only caller is the Telegram login link, and the signature is deliberately narrow: it
 * takes a principal id and nothing that could be mistaken for a credential. Whatever
 * establishes that identity does so before calling, and is responsible for spending its own
 * one-time secret — this function is the part that knows how to make a session, not the part
 * that decides who deserves one.
 *
 * A session made this way is indistinguishable from one made with a passkey: same lifetime,
 * same row, same listing under §9.1, and the same one-press revocation. That is the point —
 * a second way in must not be a second kind of session with rules somebody has to remember.
 */
export async function openSessionFor(
  ctx: AuthContext,
  principalId: string,
): Promise<Result<SignedIn>> {
  const principal = await ctx.ports.principals.findById(principalId);
  if (principal === null || principal.status !== "active") {
    return fail(ErrorType.Forbidden, "This account is not active");
  }

  const now = ctx.ports.clock.now();
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();

  await ctx.ports.db.commit([
    ctx.ports.sessions.insert({
      id: ctx.ports.ids.next(),
      principalId: principal.id,
      tokenHash: await sha256Hex(token),
      userAgent: ctx.userAgent,
      ipHash: ctx.ipHash,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
    }),
  ]);

  return { ok: true, value: { principalId: principal.id, username: principal.username, sessionToken: token, expiresAt } };
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
): Promise<{ principalId: OratorId; username: string; sessionId: OratorId } | null> {
  const session = await ports.sessions.findByHash(await sha256Hex(cookieValue));
  if (session === null || session.revokedAt !== null) return null;
  if (Date.parse(session.expiresAt) <= ports.clock.now().getTime()) return null;

  const principal = await ports.principals.findById(session.principalId);
  if (principal === null || principal.status !== "active") return null;

  // The id travels with the session so `/settings` can mark which row the reader is
  // sitting in. Ending "this browser" and ending "that other one" are different acts, and
  // a list that cannot tell them apart invites the wrong one.
  return { principalId: principal.id, username: principal.username, sessionId: session.id };
}

export async function signOut(ports: AuthPorts, cookieValue: string): Promise<void> {
  const session = await ports.sessions.findByHash(await sha256Hex(cookieValue));
  if (session === null) return;
  await ports.db.commit([ports.sessions.revoke(session.id, ports.clock.now().toISOString())]);
}

// ---------------------------------------------------------------------------
// The challenge (ADR 0004)
// ---------------------------------------------------------------------------

/**
 * A WebAuthn challenge, sealed so it can be handed to the client and trusted on return.
 *
 * ADR 0004 keeps the challenge in a cookie rather than a table: a table makes every
 * sign-in *attempt* a write on an unauthenticated endpoint, which is a flood surface
 * pointed at the database, and needs a retention handler for rows that live sixty seconds.
 * What replaces the table is this — the challenge, its expiry, and an HMAC over both.
 *
 * In the domain rather than in the web app because it is a security policy, not HTTP: how
 * long a challenge is good for and what makes it trustworthy are decisions, and decisions
 * belong where they can be tested (§68). Only the cookie's formatting stays in the adapter.
 */
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

/** `challenge.expiry.mac` — enough to verify on return without having stored anything. */
export async function sealChallenge(secret: string, challenge: string, now: number): Promise<string> {
  const expiry = now + CHALLENGE_LIFETIME_MS;
  const payload = `${challenge}.${expiry}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

/**
 * Returns the challenge, or null if it is missing, malformed, tampered with or expired.
 *
 * One null for every failure. A caller that could tell "expired" from "forged" would learn
 * something about the secret, and there is nothing useful a client can do differently
 * either way: both mean start again.
 */
export async function openChallenge(
  secret: string,
  sealed: string | null,
  now: number,
): Promise<string | null> {
  if (sealed === null) return null;
  const parts = sealed.split(".");
  if (parts.length !== 3) return null;
  const [challenge, expiry, mac] = parts as [string, string, string];

  const expected = await hmac(secret, `${challenge}.${expiry}`);
  // Constant-time comparison. The values are short and the timing signal is weak, but the
  // loop costs nothing and removes the question entirely.
  if (expected.length !== mac.length) return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
  if (difference !== 0) return null;

  const deadline = Number(expiry);
  if (!Number.isFinite(deadline) || deadline <= now) return null;
  return challenge;
}

/**
 * Who is asking, from either kind of credential (SPEC §42.2, §9.1).
 *
 * A browser session, or an API token. Both are accepted *here*, on the web surface, and
 * the asymmetry is deliberate: §9.1 forbids the API accepting a cookie because a browser
 * sends one unprompted, but nothing sends an `Authorization` header by accident, so taking
 * a token on a page is not the same risk in reverse.
 *
 * The reason it has to accept a token at all is the bootstrap. Registering a passkey needs
 * an established identity, and a person who has just registered has exactly one credential
 * — the token `POST /v1/humans` handed them (§42.2). Without this, a new account could
 * never attach its first passkey, which is the same dead end §42.2 was written to close.
 */
export async function identify(
  ports: AuthPorts,
  input: { sessionCookie: string | null; bearerToken: string | null },
): Promise<{ principalId: OratorId; username: string } | null> {
  if (input.sessionCookie !== null) {
    const session = await resolveSession(ports, input.sessionCookie);
    if (session !== null) return session;
  }

  if (input.bearerToken !== null) {
    const result = await authenticate(ports, input.bearerToken);
    if (!result.ok) return null;

    const principal = await ports.principals.findById(result.value.actor.principalId);
    // Only a person. An agent holding a token has no business registering a passkey, and
    // `beginPasskeyRegistration` refuses one anyway — this is the earlier, clearer refusal.
    if (principal === null || principal.kind !== "human" || principal.status !== "active") return null;
    return { principalId: principal.id, username: principal.username };
  }

  return null;
}

/** The credential id a browser echoes back, without trusting the rest of the payload yet. */
function credentialIdOf(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const id = (response as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= 512 ? id : null;
}

import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryAuthPorts, type MemoryAuth } from "../testing/memory-auth.js";
import { generateToken } from "../identity/tokens.js";
import {
  beginPasskeyAuthentication,
  beginSignup,
  completeSignup,
  identify,
  beginPasskeyRegistration,
  completePasskeyAuthentication,
  completePasskeyRegistration,
  openChallenge,
  openSessionFor,
  resolveSession,
  sealChallenge,
  signOut,
  CHALLENGE_LIFETIME_MS,
  SESSION_LIFETIME_MS,
  type AuthContext,
} from "./auth.js";

let auth: MemoryAuth;

const HUMAN = "HUMAN-1";
const OTHER = "HUMAN-2";
const AGENT = "AGENT-1";

const ctx = (): AuthContext => ({
  ports: auth.ports,
  requestId: "REQ",
  rpId: "orator.space",
  rpName: "Orator.Space",
  origin: "https://orator.space",
  userAgent: "test",
  ipHash: null,
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const errorOf = (r: { ok: boolean; error?: { type: string } }) => {
  if (r.ok) throw new Error("expected failure");
  return r.error!.type;
};

const principal = (id: string, username: string, extra: Record<string, unknown> = {}) => ({
  id: id as never,
  kind: "human" as const,
  username,
  usernameSkeleton: username,
  displayName: null,
  bio: null,
  status: "active" as const,
  platformRole: "user" as const,
  systemAccount: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

/** A credential the scripted verifier will claim to have checked. */
const credential = (id: string) => ({
  credentialId: id,
  publicKey: "cHVibGljLWtleQ",
  signCount: 0,
  backedUp: true,
  aaguid: null,
  transports: ["internal"],
});

/** Registers a passkey for `HUMAN` and returns its credential id. */
async function register(id = "cred-1"): Promise<string> {
  const options = unwrap(await beginPasskeyRegistration(ctx(), HUMAN));
  auth.verifier.nextRegistration(credential(id));
  unwrap(
    await completePasskeyRegistration(ctx(), {
      principalId: HUMAN,
      challenge: options.challenge,
      response: { id },
    }),
  );
  return id;
}

/** A live API token for `principalId`, for the one path that accepts either credential. */
async function issueToken(principalId: string): Promise<string> {
  const generated = await generateToken();
  await auth.ports.db.commit([
    auth.ports.tokens.insert({
      id: auth.ports.ids.next(),
      principalId: principalId as never,
      name: "test",
      tokenHash: generated.tokenHash,
      prefix: generated.prefix,
      scopes: ["articles:read"],
      expiresAt: null,
      createdAt: "2026-08-22T12:00:00.000Z",
    }),
  ]);
  return generated.token;
}

/** Signs in with an already-registered credential, returning the session cookie value. */
async function signIn(id = "cred-1", signCount = 1): Promise<string> {
  const options = await beginPasskeyAuthentication(ctx());
  auth.verifier.nextAuthentication({ credentialId: id, newSignCount: signCount });
  const result = unwrap(
    await completePasskeyAuthentication(ctx(), { challenge: options.challenge, response: { id } }),
  );
  return result.sessionToken;
}

beforeEach(() => {
  auth = createMemoryAuthPorts({ now: new Date("2026-08-22T12:00:00.000Z") });
  auth.principals.set(HUMAN, principal(HUMAN, "reader"));
  auth.principals.set(OTHER, principal(OTHER, "someone-else"));
  auth.principals.set(AGENT, principal(AGENT, "researcher", { kind: "agent", ownerPrincipalId: HUMAN }));
});

describe("registering a passkey (SPEC §42.2)", () => {
  it("stores the credential against the principal", async () => {
    const id = await register();
    const stored = [...auth.credentials.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.credentialId).toBe(id);
    expect(stored[0]?.principalId).toBe(HUMAN);
  });

  it("asks for a discoverable credential, so signing in needs no username first", async () => {
    const options = unwrap(await beginPasskeyRegistration(ctx(), HUMAN));
    expect(options.authenticatorSelection["residentKey"]).toBe("required");
  });

  it("excludes the passkeys already registered, so one device is not enrolled twice", async () => {
    const id = await register();
    const options = unwrap(await beginPasskeyRegistration(ctx(), HUMAN));
    expect(options.excludeCredentials.map((entry) => entry.id)).toEqual([id]);
  });

  it("refuses an agent: a passkey is how a person proves presence (§8.1)", async () => {
    const result = await beginPasskeyRegistration(ctx(), AGENT);
    expect(errorOf(result)).toBe("forbidden");
  });

  it("refuses an unknown or suspended principal", async () => {
    expect(errorOf(await beginPasskeyRegistration(ctx(), "NOBODY"))).toBe("not-found");
    auth.principals.set(HUMAN, { ...auth.principals.get(HUMAN)!, status: "suspended" });
    expect(errorOf(await beginPasskeyRegistration(ctx(), HUMAN))).toBe("not-found");
  });

  it("stores nothing when the ceremony fails to verify", async () => {
    const options = unwrap(await beginPasskeyRegistration(ctx(), HUMAN));
    auth.verifier.nextRegistration(null);

    const result = await completePasskeyRegistration(ctx(), {
      principalId: HUMAN,
      challenge: options.challenge,
      response: { id: "cred-1" },
    });

    expect(errorOf(result)).toBe("validation-failed");
    expect(auth.credentials.size).toBe(0);
  });

  it("refuses to attach one credential to two accounts", async () => {
    const id = await register();
    const options = unwrap(await beginPasskeyRegistration(ctx(), OTHER));
    auth.verifier.nextRegistration(credential(id));

    const result = await completePasskeyRegistration(ctx(), {
      principalId: OTHER,
      challenge: options.challenge,
      response: { id },
    });
    expect(errorOf(result)).toBe("conflict");
  });
});

describe("signing in (SPEC §42.2, §9.1)", () => {
  it("opens a session for the credential's owner", async () => {
    await register();
    const token = await signIn();

    const session = await resolveSession(auth.ports, token);
    expect(session?.principalId).toBe(HUMAN);
    expect(session?.username).toBe("reader");
  });

  it("never asks who is signing in, and never says who is registered", async () => {
    await register();
    const options = await beginPasskeyAuthentication(ctx());
    // An empty allow-list is what makes this endpoint safe to call anonymously: it
    // discloses nothing about which accounts exist.
    expect(options.allowCredentials).toEqual([]);
  });

  it("stores only the hash of the session value, never the value", async () => {
    await register();
    const token = await signIn();
    const stored = [...auth.sessions.values()][0]!;
    expect(stored.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("issues a value that could not be mistaken for an API token (§9.1)", async () => {
    await register();
    const token = await signIn();
    // `bearerFrom` requires the `orat_` prefix, so this cannot be presented as a bearer
    // token even by a caller who tries. The separation is structural, not a rule.
    expect(token.startsWith("orat_")).toBe(false);
    expect(token.startsWith("sess.")).toBe(true);
  });

  it("says the same thing for an unknown credential as for a bad signature", async () => {
    await register();

    const unknown = await beginPasskeyAuthentication(ctx());
    auth.verifier.nextAuthentication({ credentialId: "nope", newSignCount: 1 });
    const missing = await completePasskeyAuthentication(ctx(), {
      challenge: unknown.challenge,
      response: { id: "nope" },
    });

    const bad = await beginPasskeyAuthentication(ctx());
    auth.verifier.nextAuthentication(null);
    const refused = await completePasskeyAuthentication(ctx(), {
      challenge: bad.challenge,
      response: { id: "cred-1" },
    });

    // Identical outcomes: otherwise this endpoint is a way to test whether a credential
    // exists, one guess at a time.
    expect(errorOf(missing)).toBe("unauthenticated");
    expect(errorOf(refused)).toBe("unauthenticated");
    expect(auth.sessions.size).toBe(0);
  });

  it("refuses a malformed response before touching storage", async () => {
    const result = await completePasskeyAuthentication(ctx(), { challenge: "x", response: { id: 42 } });
    expect(errorOf(result)).toBe("validation-failed");
  });

  it("refuses a suspended account even with a valid passkey", async () => {
    await register();
    auth.principals.set(HUMAN, { ...auth.principals.get(HUMAN)!, status: "suspended" });

    const options = await beginPasskeyAuthentication(ctx());
    auth.verifier.nextAuthentication({ credentialId: "cred-1", newSignCount: 1 });
    const result = await completePasskeyAuthentication(ctx(), {
      challenge: options.challenge,
      response: { id: "cred-1" },
    });

    expect(errorOf(result)).toBe("forbidden");
    expect(auth.sessions.size).toBe(0);
  });

  it("records the sign count, including when it does not advance", async () => {
    await register();
    // A synced passkey legitimately reports zero forever, so a count that fails to advance
    // is a signal for moderation and not grounds to lock someone out (§42.2).
    await signIn("cred-1", 0);
    const stored = [...auth.credentials.values()][0]!;
    expect(stored.signCount).toBe(0);
    expect(stored.lastUsedAt).not.toBeNull();
  });

  it("advances the stored count when the authenticator advances it", async () => {
    await register();
    await signIn("cred-1", 7);
    expect([...auth.credentials.values()][0]?.signCount).toBe(7);
  });
});

describe("sessions", () => {
  it("stops resolving once it expires", async () => {
    await register();
    const token = await signIn();

    auth.setNow(new Date(Date.parse("2026-08-22T12:00:00.000Z") + SESSION_LIFETIME_MS + 1000));
    expect(await resolveSession(auth.ports, token)).toBeNull();
  });

  it("stops resolving once it is revoked", async () => {
    await register();
    const token = await signIn();

    await signOut(auth.ports, token);
    expect(await resolveSession(auth.ports, token)).toBeNull();
  });

  it("stops resolving once the account stops being active", async () => {
    await register();
    const token = await signIn();

    auth.principals.set(HUMAN, { ...auth.principals.get(HUMAN)!, status: "deleted" });
    expect(await resolveSession(auth.ports, token)).toBeNull();
  });

  it("does not resolve a value that was never issued", async () => {
    expect(await resolveSession(auth.ports, "sess.invented")).toBeNull();
  });

  it("treats signing out of an unknown session as a no-op rather than an error", async () => {
    await expect(signOut(auth.ports, "sess.invented")).resolves.toBeUndefined();
  });

  it("issues a distinct value each time, so two devices are two sessions", async () => {
    await register();
    const first = await signIn();
    const second = await signIn();

    expect(first).not.toBe(second);
    expect(auth.sessions.size).toBe(2);
    // Revoking one leaves the other alone.
    await signOut(auth.ports, first);
    expect(await resolveSession(auth.ports, first)).toBeNull();
    expect(await resolveSession(auth.ports, second)).not.toBeNull();
  });
});

/**
 * A session opened for an identity established elsewhere (SPEC §9.3, §9.1).
 *
 * The Telegram login link is the only caller, and the point of the tests is that this makes
 * an *ordinary* session: a second way in must not be a second kind of session, with a
 * lifetime or a listing somebody has to remember is different.
 */
describe("opening a session for a principal (§9.3)", () => {
  it("makes a session indistinguishable from one a passkey made", async () => {
    await register();
    const opened = unwrap(await openSessionFor(ctx(), HUMAN));

    const resolved = await resolveSession(auth.ports, opened.sessionToken);
    expect(resolved?.principalId).toBe(HUMAN);
    expect(Date.parse(opened.expiresAt) - Date.parse("2026-08-22T12:00:00.000Z")).toBe(SESSION_LIFETIME_MS);
  });

  it("is listed and revocable like any other (§9.1)", async () => {
    await register();
    const opened = unwrap(await openSessionFor(ctx(), HUMAN));

    expect(auth.sessions.size).toBe(1);
    await signOut(auth.ports, opened.sessionToken);
    expect(await resolveSession(auth.ports, opened.sessionToken)).toBeNull();
  });

  it("refuses an account that is not active", async () => {
    await register();
    auth.principals.set(HUMAN, { ...auth.principals.get(HUMAN)!, status: "suspended" });
    const result = await openSessionFor(ctx(), HUMAN);
    expect(result.ok).toBe(false);
  });

  it("refuses a principal that does not exist", async () => {
    // The caller establishes identity; this refuses to invent one. A principal id that is
    // not there is a bug upstream, and answering with a session would hide it.
    expect((await openSessionFor(ctx(), "NOBODY")).ok).toBe(false);
  });
});

describe("the sealed challenge (ADR 0004)", () => {
  const SECRET = "a-secret-of-at-least-thirty-two-characters";
  const NOW = Date.parse("2026-08-22T12:00:00.000Z");

  /**
   * The whole of what replaces a challenges table.
   *
   * ADR 0004 rejected a table because it makes every sign-in attempt a write on an
   * unauthenticated endpoint. What carries the weight instead is this: the challenge is
   * only trustworthy on return if the seal holds, so each way it can fail to hold has a
   * test rather than a comment.
   */
  it("round-trips a challenge inside its lifetime", async () => {
    const sealed = await sealChallenge(SECRET, "the-challenge", NOW);
    expect(await openChallenge(SECRET, sealed, NOW + 1000)).toBe("the-challenge");
  });

  it("refuses one signed with a different secret", async () => {
    const sealed = await sealChallenge("another-secret-of-at-least-thirty-two-chars", "the-challenge", NOW);
    expect(await openChallenge(SECRET, sealed, NOW + 1000)).toBeNull();
  });

  it("refuses a challenge someone edited, seal and all", async () => {
    const sealed = await sealChallenge(SECRET, "the-challenge", NOW);
    const [, expiry, mac] = sealed.split(".");
    // An attacker who could substitute the challenge would defeat the point of having one.
    expect(await openChallenge(SECRET, `chosen-by-me.${expiry}.${mac}`, NOW + 1000)).toBeNull();
  });

  it("refuses an expiry someone extended", async () => {
    const sealed = await sealChallenge(SECRET, "the-challenge", NOW);
    const [challenge, , mac] = sealed.split(".");
    expect(await openChallenge(SECRET, `${challenge}.${NOW + 86_400_000}.${mac}`, NOW + 1000)).toBeNull();
  });

  it("refuses one past its expiry", async () => {
    const sealed = await sealChallenge(SECRET, "the-challenge", NOW);
    expect(await openChallenge(SECRET, sealed, NOW + CHALLENGE_LIFETIME_MS + 1)).toBeNull();
  });

  it("refuses a missing or malformed value without throwing", async () => {
    expect(await openChallenge(SECRET, null, NOW)).toBeNull();
    expect(await openChallenge(SECRET, "", NOW)).toBeNull();
    expect(await openChallenge(SECRET, "not-sealed", NOW)).toBeNull();
    expect(await openChallenge(SECRET, "a.b", NOW)).toBeNull();
    expect(await openChallenge(SECRET, `the-challenge.not-a-number.${"x".repeat(43)}`, NOW)).toBeNull();
  });

  it("produces a different seal for the same challenge at a different moment", async () => {
    const first = await sealChallenge(SECRET, "the-challenge", NOW);
    const second = await sealChallenge(SECRET, "the-challenge", NOW + 1);
    expect(first).not.toBe(second);
  });
});

/**
 * Signing up (SPEC §42.2, §7.3).
 *
 * The whole of this path was untested: `beginSignup`, `completeSignup` and `identify`
 * accounted for most of the uncovered half of this file. It is also the one path a stranger
 * can reach without holding anything — the account does not exist yet, so there is no
 * credential to check and every guard here is the only guard.
 */
describe("signing up", () => {
  const start = async (username = "newcomer", displayName: string | null = null) =>
    beginSignup(ctx(), { username, ...(displayName === null ? {} : { displayName }) });

  /** Runs the whole ceremony, returning what the caller would be handed. */
  async function signUp(username = "newcomer", credentialId = "cred-new") {
    const begun = unwrap(await start(username));
    auth.verifier.nextRegistration(credential(credentialId));
    return unwrap(
      await completeSignup(ctx(), {
        principalId: begun.principalId,
        username: begun.username,
        displayName: null,
        challenge: begun.options.challenge,
        response: { id: credentialId },
      }),
    );
  }

  it("creates the account, its credential and its session in one go", async () => {
    const result = await signUp();

    const created = auth.principals.get(result.principalId);
    expect(created?.username).toBe("newcomer");
    expect(created?.kind).toBe("human");
    expect(created?.status).toBe("active");
    expect([...auth.credentials.values()].some((c) => c.principalId === result.principalId)).toBe(true);
    expect(await resolveSession(auth.ports, result.sessionToken)).toMatchObject({
      principalId: result.principalId,
      username: "newcomer",
    });
  });

  it("mints the id before the ceremony, so the authenticator binds to the account it creates", async () => {
    // The handle the authenticator stores is the principal id, and it is chosen on the way
    // out. If `completeSignup` invented a different one the passkey would belong to nobody.
    const begun = unwrap(await start());
    auth.verifier.nextRegistration(credential("cred-new"));
    const done = unwrap(
      await completeSignup(ctx(), {
        principalId: begun.principalId,
        username: begun.username,
        displayName: null,
        challenge: begun.options.challenge,
        response: { id: "cred-new" },
      }),
    );
    expect(done.principalId).toBe(begun.principalId);
  });

  it("canonicalises the name and refuses one that cannot be a username (§7.3)", async () => {
    const result = await start("  ");
    expect(errorOf(result)).toBe("validation-failed");
  });

  it("refuses a name somebody already holds", async () => {
    expect(errorOf(await start("reader"))).toBe("conflict");
  });

  /**
   * §7.3 — a name that reads as another one is refused by its own error.
   *
   * "Taken" would be baffling: the two look different to the person typing and identical to
   * everyone else, so the message has to name the account it collides with.
   */
  it("refuses a name confusable with an existing one, and says which", async () => {
    // `paypa1` canonicalises to the skeleton `paypal`, which is the collision (§7.3).
    auth.principals.set("HUMAN-3", principal("HUMAN-3", "paypal"));

    const result = await start("paypa1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("conflict");
      expect(JSON.stringify(result.error)).toContain("paypal");
    }
  });

  it("excludes nothing on the way out, because the account does not exist yet", async () => {
    const begun = unwrap(await start());
    expect(begun.options.excludeCredentials).toEqual([]);
  });

  it("creates nothing when the ceremony fails to verify", async () => {
    const begun = unwrap(await start());
    auth.verifier.nextRegistration(null);

    const result = await completeSignup(ctx(), {
      principalId: begun.principalId,
      username: begun.username,
      displayName: null,
      challenge: begun.options.challenge,
      response: { id: "cred-new" },
    });

    expect(errorOf(result)).toBe("validation-failed");
    expect(auth.principals.get(begun.principalId)).toBeUndefined();
    expect(auth.credentials.size).toBe(0);
  });

  /**
   * One passkey, one account (§42.2).
   *
   * `excludeCredentials` was empty on the way out — there was nothing to exclude for — so an
   * authenticator that already holds a passkey for this site will happily mint a second. The
   * refusal has to happen on the way back, where the credential id is finally known.
   */
  it("refuses a passkey that already belongs to somebody", async () => {
    const existing = await register();
    const begun = unwrap(await start());
    auth.verifier.nextRegistration(credential(existing));

    const result = await completeSignup(ctx(), {
      principalId: begun.principalId,
      username: begun.username,
      displayName: null,
      challenge: begun.options.challenge,
      response: { id: existing },
    });

    expect(errorOf(result)).toBe("conflict");
    expect(auth.principals.get(begun.principalId)).toBeUndefined();
  });

  it("re-checks the name on the way back, since minutes have passed", async () => {
    // The name was free when the ceremony began. The unique index is what actually decides,
    // but the check turns a race into a sentence rather than a 500.
    const begun = unwrap(await start());
    auth.principals.set("HUMAN-4", principal("HUMAN-4", begun.username));
    auth.verifier.nextRegistration(credential("cred-new"));

    const result = await completeSignup(ctx(), {
      principalId: begun.principalId,
      username: begun.username,
      displayName: null,
      challenge: begun.options.challenge,
      response: { id: "cred-new" },
    });

    expect(errorOf(result)).toBe("conflict");
  });

  it("trims a display name and falls back to the username", async () => {
    const begun = unwrap(await start("newcomer", "   "));
    // Empty after trimming is not a display name; the authenticator is shown the username.
    expect(begun.options.user.displayName).toBe("newcomer");
  });
});

/**
 * Who is asking, for the one endpoint that accepts either credential (§42.2, §9.1).
 *
 * `identify` is the exception to §9.1's rule that a browser session is never accepted on the
 * API: attaching a first passkey has to work for somebody who has only ever held a token,
 * or that account can never reach the browser at all.
 */
describe("identify", () => {
  it("prefers a session, and answers with who holds it", async () => {
    await register();
    const cookie = await signIn();

    expect(await identify(auth.ports, { sessionCookie: cookie, bearerToken: null })).toMatchObject({
      principalId: HUMAN,
      username: "reader",
    });
  });

  it("falls through to a bearer token when the cookie resolves to nothing", async () => {
    // An expired or revoked cookie is not a refusal on its own: the caller may also be
    // holding a token, and refusing here would be the dead end §42.2 exists to close.
    const token = await issueToken(HUMAN);
    expect(await identify(auth.ports, { sessionCookie: "sess.nonsense", bearerToken: token })).toEqual({
      principalId: HUMAN,
      username: "reader",
    });
  });

  it("answers nothing when neither credential is offered", async () => {
    expect(await identify(auth.ports, { sessionCookie: null, bearerToken: null })).toBeNull();
  });

  it("answers nothing for a token that is not one", async () => {
    expect(await identify(auth.ports, { sessionCookie: null, bearerToken: "orat_sk_live_nope" })).toBeNull();
  });

  it("refuses an agent's token: a passkey is a person's (§8.1)", async () => {
    const token = await issueToken(AGENT);
    expect(await identify(auth.ports, { sessionCookie: null, bearerToken: token })).toBeNull();
  });

  it("refuses a suspended account holding a valid token", async () => {
    const token = await issueToken(HUMAN);
    auth.principals.set(HUMAN, { ...auth.principals.get(HUMAN)!, status: "suspended" });
    expect(await identify(auth.ports, { sessionCookie: null, bearerToken: token })).toBeNull();
  });
});

import { encodeId, type OratorId } from "@orator/protocol";
import type {
  AuthenticationOptions,
  CredentialRecord,
  CredentialRepo,
  PasskeyVerifier,
  PrincipalRecord,
  RegistrationOptions,
  SessionRecord,
  SessionRepo,
  VerifiedAuthentication,
  VerifiedRegistration,
} from "../ports/index.js";
import type { AuthPorts } from "../services/auth.js";
import { createMemoryPorts } from "./memory-repos.js";

/**
 * In-memory doubles for the sign-in flow (SPEC §42.2, ADR 0004).
 *
 * The verifier is scripted rather than real. Verifying a WebAuthn ceremony is CBOR and
 * ASN.1 parsing that belongs to a library and is tested by that library; what these tests
 * are for is the part Orator wrote — whose credential it is, what a failed verification
 * does, whether the sign count is recorded, and what a session means afterwards.
 */

export interface ScriptedVerifier extends PasskeyVerifier {
  /** What the next `verifyRegistration` returns. Null means "the ceremony failed". */
  nextRegistration(result: VerifiedRegistration | null): void;
  nextAuthentication(result: VerifiedAuthentication | null): void;
  /** Every challenge this verifier handed out, in order. */
  challenges: string[];
}

export interface MemoryAuth {
  ports: AuthPorts;
  verifier: ScriptedVerifier;
  credentials: Map<string, CredentialRecord>;
  sessions: Map<string, SessionRecord & { tokenHash: string }>;
  principals: Map<string, PrincipalRecord>;
  setNow(date: Date): void;
}

export function createMemoryAuthPorts(options: { now?: Date } = {}): MemoryAuth {
  const base = createMemoryPorts(options.now === undefined ? {} : { now: options.now });

  const credentialStore = new Map<string, CredentialRecord>();
  const sessionStore = new Map<
    string,
    SessionRecord & { tokenHash: string; userAgent: string | null }
  >();

  const asWrite = (apply: () => number | void) => apply as never;

  const credentials: CredentialRepo = {
    async findByCredentialId(credentialId) {
      return [...credentialStore.values()].find((c) => c.credentialId === credentialId) ?? null;
    },
    async listFor(principalId) {
      return [...credentialStore.values()].filter((c) => c.principalId === principalId);
    },
    deleteAllFor: (principalId) =>
      asWrite(() => {
        for (const [id, record] of credentialStore) {
          if (record.principalId === principalId) credentialStore.delete(id);
        }
      }),
    insert: (credential) =>
      asWrite(() => {
        credentialStore.set(credential.id, { ...credential, lastUsedAt: null });
        return 1;
      }),
    recordUse: (id, signCount, at) =>
      asWrite(() => {
        const credential = credentialStore.get(id);
        if (credential === undefined) return 0;
        credentialStore.set(id, { ...credential, signCount, lastUsedAt: at });
        return 1;
      }),
  };

  const sessions: SessionRepo = {
    async findByHash(tokenHash) {
      return [...sessionStore.values()].find((s) => s.tokenHash === tokenHash) ?? null;
    },
    async listFor(principalId) {
      return [...sessionStore.values()].filter(
        (s) => s.principalId === principalId && s.revokedAt === null,
      );
    },
    insert: (session) =>
      asWrite(() => {
        sessionStore.set(session.id, session);
        return 1;
      }),
    touch: (id, at) =>
      asWrite(() => {
        const session = sessionStore.get(id);
        if (session === undefined) return 0;
        sessionStore.set(id, { ...session, lastSeenAt: at });
        return 1;
      }),
    revoke: (id, at) =>
      asWrite(() => {
        const session = sessionStore.get(id);
        if (session === undefined) return 0;
        sessionStore.set(id, { ...session, revokedAt: at });
        return 1;
      }),
    revokeAllFor: (principalId, at) =>
      asWrite(() => {
        let changed = 0;
        for (const [id, session] of sessionStore) {
          if (session.principalId !== principalId || session.revokedAt !== null) continue;
          sessionStore.set(id, { ...session, revokedAt: at });
          changed += 1;
        }
        return changed;
      }),
  };

  let registration: VerifiedRegistration | null = null;
  let authentication: VerifiedAuthentication | null = null;
  let counter = 0;
  const challenges: string[] = [];

  const nextChallenge = () => {
    counter += 1;
    const bytes = new Uint8Array(16);
    bytes[15] = counter;
    const challenge = encodeId(bytes);
    challenges.push(challenge);
    return challenge;
  };

  const verifier: ScriptedVerifier = {
    challenges,
    nextRegistration(result) {
      registration = result;
    },
    nextAuthentication(result) {
      authentication = result;
    },
    async registrationOptions(input): Promise<RegistrationOptions> {
      return {
        challenge: nextChallenge(),
        rp: { id: input.rpId, name: input.rpName },
        user: { id: input.principalId, name: input.username, displayName: input.displayName },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        timeout: 60_000,
        attestation: "none",
        excludeCredentials: input.existing.map((id) => ({ id, type: "public-key" as const })),
        authenticatorSelection: { residentKey: "required" },
      };
    },
    async verifyRegistration() {
      return registration;
    },
    async authenticationOptions(input): Promise<AuthenticationOptions> {
      return {
        challenge: nextChallenge(),
        rpId: input.rpId,
        timeout: 60_000,
        userVerification: "preferred",
        allowCredentials: [],
      };
    },
    async verifyAuthentication() {
      return authentication;
    },
  };

  return {
    ports: {
      db: base.db,
      principals: base.principals,
      credentials,
      sessions,
      passkeys: verifier,
      tokens: base.tokens,
      clock: base.clock,
      ids: base.ids,
    },
    verifier,
    credentials: credentialStore,
    sessions: sessionStore,
    principals: base.state.principals,
    setNow: base.setNow,
  };
}

export type { OratorId };

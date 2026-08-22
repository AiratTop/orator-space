import type { OratorId } from "@orator/protocol";
import type { PendingWrite } from "./database.js";

/**
 * Passkeys and browser sessions (SPEC §42.2, §9.1, ADR 0004).
 *
 * The verifier is a port because what it does is parsing, not deciding. CBOR attestation
 * objects, ASN.1 certificate chains and COSE keys have nothing to do with Orator's domain,
 * and keeping them behind this line is what lets the domain tests run in plain Node (§68).
 * What the domain decides is what a verified credential *means*: whose it is, whether its
 * sign count moved backwards, and what session to open.
 */

export interface RegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ alg: number; type: "public-key" }>;
  timeout: number;
  attestation: string;
  excludeCredentials: Array<{ id: string; type: "public-key" }>;
  authenticatorSelection: Record<string, unknown>;
}

export interface AuthenticationOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: string;
  allowCredentials: Array<{ id: string; type: "public-key" }>;
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  signCount: number;
  backedUp: boolean;
  aaguid: string | null;
  transports: string[] | null;
}

export interface VerifiedAuthentication {
  credentialId: string;
  newSignCount: number;
}

export interface PasskeyVerifier {
  registrationOptions(input: {
    rpId: string;
    rpName: string;
    principalId: string;
    username: string;
    displayName: string;
    existing: readonly string[];
  }): Promise<RegistrationOptions>;

  verifyRegistration(input: {
    response: unknown;
    expectedChallenge: string;
    rpId: string;
    origin: string;
  }): Promise<VerifiedRegistration | null>;

  authenticationOptions(input: {
    rpId: string;
    allow: readonly string[];
  }): Promise<AuthenticationOptions>;

  verifyAuthentication(input: {
    response: unknown;
    expectedChallenge: string;
    rpId: string;
    origin: string;
    credential: { id: string; publicKey: string; signCount: number };
  }): Promise<VerifiedAuthentication | null>;
}

export interface CredentialRecord {
  id: OratorId;
  principalId: OratorId;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string | null;
  aaguid: string | null;
  label: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SessionRecord {
  id: OratorId;
  principalId: OratorId;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CredentialRepo {
  findByCredentialId(credentialId: string): Promise<CredentialRecord | null>;
  listFor(principalId: string): Promise<CredentialRecord[]>;
  insert(credential: Omit<CredentialRecord, "lastUsedAt">): PendingWrite;
  /** SPEC §42.2 — a sign count that fails to advance is the cloned-authenticator signal. */
  recordUse(id: string, signCount: number, at: string): PendingWrite;
  /**
   * SPEC §23.5 — removed outright on account closure, not revoked.
   *
   * A public key bound to an authenticator somebody still carries is the one credential
   * here that continues to exist outside the database. Keeping a revoked copy would keep a
   * record of which device belonged to a person who asked to be forgotten, and it protects
   * nothing: the account it opened is closed.
   */
  deleteAllFor(principalId: string): PendingWrite;
}

export interface SessionRepo {
  findByHash(tokenHash: string): Promise<SessionRecord | null>;
  insert(session: SessionRecord & { tokenHash: string; userAgent: string | null; ipHash: string | null }): PendingWrite;
  touch(id: string, at: string): PendingWrite;
  revoke(id: string, at: string): PendingWrite;
  revokeAllFor(principalId: string, at: string): PendingWrite;
}

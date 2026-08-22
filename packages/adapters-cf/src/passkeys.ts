import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationOptions,
  PasskeyVerifier,
  RegistrationOptions,
  VerifiedAuthentication,
  VerifiedRegistration,
} from "@orator/core/ports";

/**
 * WebAuthn ceremony verification (ADR 0004).
 *
 * The whole of the library's surface lives here, behind the port. Everything below is
 * translation: the library's shapes in, the domain's shapes out. No decision is made in
 * this file — a failed verification returns null and the service decides what that means.
 */

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export function createPasskeyVerifier(): PasskeyVerifier {
  return {
    async registrationOptions(input): Promise<RegistrationOptions> {
      const options = await generateRegistrationOptions({
        rpName: input.rpName,
        rpID: input.rpId,
        // The encoder's buffer type is wider than the library's signature; the bytes are
        // the same and there is no SharedArrayBuffer anywhere near a Worker request.
        userID: new TextEncoder().encode(input.principalId) as Uint8Array<ArrayBuffer>,
        userName: input.username,
        userDisplayName: input.displayName,
        // §42.2 — the credential must be discoverable, so a returning reader can sign in
        // without first telling the site who they are. That is the whole point of a
        // passkey over a password: no identifier to remember and none to phish.
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        attestationType: "none",
        excludeCredentials: input.existing.map((id) => ({ id })),
      });

      return {
        challenge: options.challenge,
        rp: { id: input.rpId, name: input.rpName },
        user: { id: options.user.id, name: options.user.name, displayName: options.user.displayName },
        pubKeyCredParams: options.pubKeyCredParams.map((param) => ({ alg: param.alg, type: "public-key" })),
        timeout: options.timeout ?? 60_000,
        attestation: options.attestation ?? "none",
        excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({
          id: credential.id,
          type: "public-key",
        })),
        authenticatorSelection: { ...options.authenticatorSelection },
      };
    },

    async verifyRegistration(input): Promise<VerifiedRegistration | null> {
      try {
        const verification = await verifyRegistrationResponse({
          response: input.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
          expectedChallenge: input.expectedChallenge,
          expectedOrigin: input.origin,
          expectedRPID: input.rpId,
          requireUserVerification: false,
        });

        if (!verification.verified || verification.registrationInfo === undefined) return null;
        const { credential, aaguid, credentialBackedUp } = verification.registrationInfo;

        return {
          credentialId: credential.id,
          publicKey: b64url(credential.publicKey),
          signCount: credential.counter,
          backedUp: credentialBackedUp,
          aaguid: aaguid ?? null,
          transports: credential.transports === undefined ? null : [...credential.transports],
        };
      } catch {
        // A malformed ceremony is an ordinary "no". Throwing would make every parse error
        // a 500 on an endpoint that unauthenticated callers can reach.
        return null;
      }
    },

    async authenticationOptions(input): Promise<AuthenticationOptions> {
      const options = await generateAuthenticationOptions({
        rpID: input.rpId,
        userVerification: "preferred",
        allowCredentials: input.allow.map((id) => ({ id })),
      });

      return {
        challenge: options.challenge,
        rpId: input.rpId,
        timeout: options.timeout ?? 60_000,
        userVerification: options.userVerification ?? "preferred",
        allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
          id: credential.id,
          type: "public-key",
        })),
      };
    },

    async verifyAuthentication(input): Promise<VerifiedAuthentication | null> {
      try {
        const verification = await verifyAuthenticationResponse({
          response: input.response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
          expectedChallenge: input.expectedChallenge,
          expectedOrigin: input.origin,
          expectedRPID: input.rpId,
          credential: {
            id: input.credential.id,
            publicKey: fromB64url(input.credential.publicKey) as Uint8Array<ArrayBuffer>,
            counter: input.credential.signCount,
          },
          requireUserVerification: false,
        });

        if (!verification.verified) return null;
        return {
          credentialId: input.credential.id,
          newSignCount: verification.authenticationInfo.newCounter,
        };
      } catch {
        return null;
      }
    },
  };
}

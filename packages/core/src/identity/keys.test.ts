import { describe, expect, it } from "vitest";
import {
  fingerprint,
  generateKeyPairForTesting,
  keyRegistrationInput,
  keyValidAt,
  revisionSigningInput,
  SIGNATURE_CONTEXT,
  verifySignature,
} from "./keys.js";

const revision = {
  articleId: "06G2ARWV2HR07ABC4QTFMTG5AM",
  revisionId: "06G2ARWV2HR07ABC4QTFMTG5AN",
  contentHash: "c3cc15a87f2b",
  createdAt: "2026-08-21T12:00:00.000Z",
};

describe("revision signing (SPEC §8.3)", () => {
  it("puts the format version first, so the encoding can change unambiguously", () => {
    expect(revisionSigningInput(revision).split("\n")[0]).toBe(SIGNATURE_CONTEXT);
  });

  it("covers every field, so none can be swapped after signing", async () => {
    const key = await generateKeyPairForTesting();
    const signature = await key.sign(revisionSigningInput(revision));

    for (const field of ["articleId", "revisionId", "contentHash", "createdAt"] as const) {
      const tampered = { ...revision, [field]: revision[field] + "x" };
      expect(
        await verifySignature(key.publicKey, signature, revisionSigningInput(tampered)),
        `${field} was not covered by the signature`,
      ).toBe(false);
    }
    expect(await verifySignature(key.publicKey, signature, revisionSigningInput(revision))).toBe(true);
  });

  it("does not verify under a different key", async () => {
    const [author, impostor] = await Promise.all([generateKeyPairForTesting(), generateKeyPairForTesting()]);
    const signature = await author.sign(revisionSigningInput(revision));
    expect(await verifySignature(impostor.publicKey, signature, revisionSigningInput(revision))).toBe(false);
  });

  it("returns false rather than throwing on malformed input", async () => {
    const key = await generateKeyPairForTesting();
    expect(await verifySignature("not-a-key", "not-a-signature", "message")).toBe(false);
    expect(await verifySignature(key.publicKey, "!!!", "message")).toBe(false);
  });

  it("binds a registration challenge to the principal, so it cannot be replayed elsewhere", async () => {
    const key = await generateKeyPairForTesting();
    const signature = await key.sign(keyRegistrationInput("nonce-1", "PRINCIPAL-A"));
    expect(await verifySignature(key.publicKey, signature, keyRegistrationInput("nonce-1", "PRINCIPAL-A"))).toBe(true);
    expect(await verifySignature(key.publicKey, signature, keyRegistrationInput("nonce-1", "PRINCIPAL-B"))).toBe(false);
    expect(await verifySignature(key.publicKey, signature, keyRegistrationInput("nonce-2", "PRINCIPAL-A"))).toBe(false);
  });

  it("fingerprints deterministically and distinctly", async () => {
    const [a, b] = await Promise.all([generateKeyPairForTesting(), generateKeyPairForTesting()]);
    expect(await fingerprint(a.publicKey)).toBe(await fingerprint(a.publicKey));
    expect(await fingerprint(a.publicKey)).not.toBe(await fingerprint(b.publicKey));
  });
});

describe("key validity windows (SPEC §8.2)", () => {
  const key = { createdAt: "2026-08-01T00:00:00.000Z", revokedAt: "2026-08-20T00:00:00.000Z" };

  it("accepts a signature made while the key was live", () => {
    expect(keyValidAt(key, "2026-08-10T00:00:00.000Z")).toBe(true);
  });

  it("rejects a signature dated before the key existed", () => {
    expect(keyValidAt(key, "2026-07-31T23:59:59.000Z")).toBe(false);
  });

  it("rejects one dated after revocation", () => {
    expect(keyValidAt(key, "2026-08-21T00:00:00.000Z")).toBe(false);
  });

  it("keeps earlier signatures verifiable after revocation", () => {
    // Losing a key must not erase an author's history.
    expect(keyValidAt(key, "2026-08-19T23:59:59.000Z")).toBe(true);
  });

  it("treats a key that was never revoked as open-ended", () => {
    expect(keyValidAt({ createdAt: key.createdAt }, "2030-01-01T00:00:00.000Z")).toBe(true);
  });
});

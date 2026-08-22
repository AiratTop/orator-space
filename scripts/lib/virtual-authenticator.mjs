/**
 * A WebAuthn authenticator, in about a hundred lines (ADR 0004).
 *
 * The sign-in ceremony is the one part of the platform that cannot be exercised by calling
 * an endpoint: it needs something holding a private key that behaves the way a security
 * key or a phone behaves. Without this, "passkey sign-in works" is a claim nobody has
 * checked — and the parts most likely to be wrong are exactly the ones a happy-path unit
 * test with a scripted verifier cannot reach: the rpId hash, the flag byte, the signature's
 * DER encoding, the bytes the signature actually covers.
 *
 * It implements the `none` attestation format and ES256, which is what the server asks for.
 * Everything here is deliberately explicit rather than pulled from a library: the point is
 * to build the bytes independently of the code that parses them.
 */
import { webcrypto } from "node:crypto";

const { subtle } = webcrypto;

const encoder = new TextEncoder();

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const sha256 = async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes));

const concat = (...parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

// --- CBOR ------------------------------------------------------------------
// Only the shapes an attestation object needs: small maps, byte strings, text strings and
// integers including negative ones (COSE labels are negative). Writing it out beats a
// dependency for a hundred bytes of fixed structure.

const cborHead = (major, value) => {
  if (value < 24) return Uint8Array.from([(major << 5) | value]);
  if (value < 0x100) return Uint8Array.from([(major << 5) | 24, value]);
  if (value < 0x10000) return Uint8Array.from([(major << 5) | 25, value >> 8, value & 0xff]);
  return Uint8Array.from([
    (major << 5) | 26,
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ]);
};

function cbor(value) {
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1);
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, item]) => concat(cbor(key), cbor(item)));
    return concat(cborHead(5, value.size), ...entries);
  }
  throw new TypeError(`cbor: unsupported value ${typeof value}`);
}

/** COSE_Key for an ES256 public key: kty EC2, alg ES256, curve P-256, and the point. */
const coseKey = (x, y) =>
  cbor(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );

/**
 * WebCrypto signs ECDSA as raw `r || s`; WebAuthn carries the ASN.1 DER form.
 *
 * Converted here rather than avoided, because the difference is precisely the kind of
 * thing a verifier gets right and a hand-rolled client gets wrong — which makes it worth
 * having on the other side of the test.
 */
function derSignature(raw) {
  const trim = (bytes) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const value = bytes.slice(start);
    // A leading bit of 1 would read as negative, so DER prefixes a zero byte.
    return value[0] & 0x80 ? concat(Uint8Array.from([0]), value) : value;
  };

  const r = trim(raw.slice(0, 32));
  const s = trim(raw.slice(32, 64));
  const body = concat(
    Uint8Array.from([0x02, r.length]),
    r,
    Uint8Array.from([0x02, s.length]),
    s,
  );
  return concat(Uint8Array.from([0x30, body.length]), body);
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

const counterBytes = (count) =>
  Uint8Array.from([(count >> 24) & 0xff, (count >> 16) & 0xff, (count >> 8) & 0xff, count & 0xff]);

/**
 * Creates an authenticator bound to one relying party.
 *
 * `signCount` stays at zero, the way a synced passkey behaves — which is also the case
 * §42.2 is careful about: a count that never advances must be a signal, not a refusal.
 */
export async function createVirtualAuthenticator({ rpId, origin }) {
  const keyPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await subtle.exportKey("jwk", keyPair.publicKey);
  const fromJwk = (value) => new Uint8Array(Buffer.from(value, "base64url"));

  const credentialId = webcrypto.getRandomValues(new Uint8Array(32));
  const rpIdHash = await sha256(encoder.encode(rpId));
  const aaguid = new Uint8Array(16);

  const clientData = (type, challenge) =>
    encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  const authenticatorData = (flags, extra = new Uint8Array(0)) =>
    concat(rpIdHash, Uint8Array.from([flags]), counterBytes(0), extra);

  return {
    credentialId: b64url(credentialId),

    /** The response `navigator.credentials.create()` would produce. */
    async register(challenge) {
      const attestedCredentialData = concat(
        aaguid,
        Uint8Array.from([credentialId.length >> 8, credentialId.length & 0xff]),
        credentialId,
        coseKey(fromJwk(jwk.x), fromJwk(jwk.y)),
      );

      const authData = authenticatorData(
        FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP | FLAG_ATTESTED_CREDENTIAL,
        attestedCredentialData,
      );

      const attestationObject = cbor(
        new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );

      const clientDataJSON = clientData("webauthn.create", challenge);
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
      };
    },

    /** The response `navigator.credentials.get()` would produce. */
    async authenticate(challenge) {
      const authData = authenticatorData(
        FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP,
      );
      const clientDataJSON = clientData("webauthn.get", challenge);

      // The signature covers the authenticator data followed by the hash of the client
      // data — not the client data itself. Getting this wrong produces a signature that
      // verifies against nothing, which is the failure this whole file exists to catch.
      const signed = concat(authData, await sha256(clientDataJSON));
      const raw = new Uint8Array(
        await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, signed),
      );

      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(derSignature(raw)),
          userHandle: null,
        },
      };
    },
  };
}

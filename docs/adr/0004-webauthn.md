# ADR 0004 — WebAuthn through a library, behind a port

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-22 |
| **Phase** | 5 |
| **Closes** | `SPEC.md` §80.3 — "WebAuthn provider: our own implementation or a library" |

## Context

§42.2 makes passkeys the way a human signs in. Verifying a WebAuthn ceremony means parsing
CBOR-encoded attestation objects, walking ASN.1 certificate structures, checking a
signature over a concatenation of hashes, and knowing which of a dozen attestation formats
is in front of you. None of it is business logic, and all of it is the kind of parsing
where a subtle mistake is indistinguishable from working code until someone attacks it.

## Decision

**Use `@simplewebauthn/server`, behind a `PasskeyVerifier` port.**

Verified in the Workers runtime: it loads under `workerd`, generates options and exposes
both verification entry points. Its dependencies are pure parsers — CBOR, ASN.1, base64 —
with no Node built-ins.

The port matters as much as the library. `packages/core` decides *what a verified
credential means* — which principal it belongs to, whether the sign-count moved backwards,
what session to create. `packages/adapters-cf` does the parsing. That keeps a heavy
dependency out of the domain, keeps the domain tests running in plain Node (§68), and means
replacing the library later is one file.

## Rejected: our own implementation

Not because it is hard to start, but because it is hard to finish. The parts that matter
are the ones nobody writes on the first pass: rejecting an attestation with the wrong
`rpIdHash`, refusing a credential whose sign count went backwards, handling the
`backupEligible` and `backupState` flag combinations that are invalid. A partial
implementation looks identical to a complete one right up until it does not.

## Where the challenge lives

**A signed, short-lived, HttpOnly cookie — not a table.**

The alternative is a `webauthn_challenges` table. It is more conventional and it was
rejected for a specific reason: it makes every sign-in *attempt* a database write on an
unauthenticated endpoint, which is a flood surface pointed straight at D1, and it needs its
own retention handler (§23.4) for rows whose entire lifetime is sixty seconds.

The challenge exists to stop a captured assertion being replayed. The cookie carrying it is
`HttpOnly`, `Secure`, `SameSite=Strict`, expires in five minutes, is signed with a secret
the client never sees, and is cleared as soon as it is used.

**Residual risk, stated rather than glossed:** the cookie is not single-use *server*-side,
so an attacker who obtains both the cookie and a matching assertion could replay them
inside the five-minute window. Obtaining that cookie requires reading an HttpOnly cookie
from the victim's browser — at which point the attacker can read the session cookie too,
and replaying a sign-in gains them nothing they do not already have.

Revisit if the platform ever accepts a WebAuthn ceremony from something other than a
browser, where the cookie assumption does not hold.

## Sessions are not accepted on the API

§9.1, restated because this ADR is where it becomes real: the cookie this flow issues is
scoped to the web hostname and `api.orator.space` never reads it. A credential the browser
attaches automatically would make every mutating endpoint CSRF-able. The API takes bearer
tokens, which a browser does not send on its own.

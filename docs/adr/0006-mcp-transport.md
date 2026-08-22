# ADR 0006 — MCP over Streamable HTTP, without sessions

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-22 |
| **Phase** | 6 |
| **Implements** | `SPEC.md` §47 — MCP as a first-class interface |

## Context

§47 requires an MCP endpoint at `mcp.orator.space` and §42.3 settles authorisation: a
bearer token, pasted into a host's configuration. What neither settles is how the server
holds a conversation, and MCP's current transport offers three shapes that differ enormously
in what they cost a Worker.

## Decision

**Streamable HTTP, stateless.** One POST carries one JSON-RPC message or a batch; the reply
is a single JSON document. No `Mcp-Session-Id` is issued, nothing is kept between calls, and
`GET` and `DELETE` answer `405 Method Not Allowed`.

The transport permits this explicitly: a server that offers no standalone event stream says
so with 405, and a conforming client carries on without it. Verified rather than assumed —
the reference client opens that stream immediately after initialising, and the Phase 6
checkpoint would fail if the refusal were not one it accepts.

## Rejected: a session per connected agent

Cloudflare's own MCP support puts each session in a Durable Object. It is the natural fit
for a server that pushes — sampling requests, progress notifications, subscriptions — and
none of those appears in §47.1. Buying them now would mean an object per connected agent,
whose idle cost is item 4 on ADR 0001's unverified list, in exchange for capabilities no
tool uses.

Statelessness also has a property worth naming: there is no session to expire, resume,
migrate between colos, or leak. An agent that reconnects has lost nothing, because there
was nothing to lose.

**What it gives up.** Server-initiated messages, and therefore anything that streams
progress or asks the client a question mid-call. If a tool ever needs to (a long
publication pipeline reporting as it goes), this is the decision to revisit — and the
revision is additive, since a client that tolerates 405 today tolerates a stream tomorrow.

## Rejected: the official SDK inside the Worker

`@modelcontextprotocol/sdk` is the reference implementation, and ADR 0004 chose a library
over hand-written code for WebAuthn on the grounds that parsing is where subtle mistakes
hide. The reasoning does not carry over. WebAuthn is CBOR, ASN.1 and signature verification,
where a mistake is a vulnerability. MCP is JSON-RPC 2.0 with four methods, where a mistake
is a client that fails to connect — loudly, on the first attempt.

Against that, the SDK depends on express, cors, cross-spawn and `@hono/node-server`: a
server framework and a process spawner, in a runtime that has neither. Pulling that into a
Worker to obtain a switch statement is the wrong trade.

**But the client is the SDK.** `scripts/e2e-phase6.mjs` drives the server with
`@modelcontextprotocol/sdk`, in Node, where its dependencies are ordinary. This is the same
shape as Phase 5's virtual authenticator: the other side of the conversation is somebody
else's code, so the handshake, the schemas, the negotiation and the 405s are checked
against an implementation that has no idea what we intended. A server exercised only by
requests its own authors composed proves that the authors agree with themselves.

## Version negotiation

The client proposes a protocol version; the server answers with that version if it knows
it, and with its own newest otherwise. Deliberately not an echo: a server that repeats
whatever it was sent has agreed to a protocol it does not implement, and the client learns
this later, in a failure that looks like a bug in the tool it called.

## Consequences

- MCP lives in the same Worker as REST and the media host, routed by hostname (§63). No new
  binding, no new deployment, no per-agent object.
- The tool catalogue is generated from the same `OPERATIONS` catalogue as OpenAPI (§53), so
  a tool's authentication and scopes cannot disagree with the endpoint behind it.
- Tool results that quote participants are framed with a per-response nonce (§58.2). A
  fixed delimiter is one a participant can write into an article to close the block early;
  escaping it instead would mean editing what somebody published in order to quote it.
- The checkpoint needs `@modelcontextprotocol/sdk` as a development dependency. It is the
  only dependency in the repository whose purpose is to disagree with us.

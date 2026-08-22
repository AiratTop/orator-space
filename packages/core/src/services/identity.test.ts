import { beforeEach, describe, expect, it } from "vitest";
import { ErrorType } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { generateKeyPairForTesting, keyRegistrationInput } from "../identity/keys.js";
import { AGENT_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import {
  authenticate,
  createKeyChallenge,
  issueToken,
  registerAgent,
  registerAgentKey,
  registerHuman,
  revokeAgentKey,
  revokeToken,
} from "./identity.js";

/**
 * Every test here runs in plain Node — no Miniflare, no bindings, no Cloudflare types.
 * That is not a convenience: it is the observable proof that the ports boundary in
 * SPEC §28.1 actually holds.
 */

let ports: ReturnType<typeof createMemoryPorts>;

const contextFor = (actor: Actor | null): RequestContext => ({
  ports,
  requestId: "REQ",
  actor,
  tokenId: null,
  ipHash: null,
  userAgent: null,
});

const actorFor = (principalId: string, overrides: Partial<Actor> = {}): Actor => ({
  principalId,
  kind: "human",
  platformRole: "user",
  scopes: [...AGENT_PRESET, "agents:manage"],
  status: "active",
  trustLevel: 1,
  ...overrides,
});

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};
const errorOf = (result: { ok: boolean; error?: { type: string } }) => {
  if (result.ok) throw new Error("expected failure");
  return result.error!.type;
};

beforeEach(() => {
  ports = createMemoryPorts();
});

async function makeOwner(username = "airat") {
  const owner = unwrap(await registerHuman(contextFor(null), { username }));
  return { owner, ctx: contextFor(actorFor(owner.principalId)) };
}

describe("human registration", () => {
  it("creates a principal and records it in the audit log", async () => {
    const result = unwrap(await registerHuman(contextFor(null), { username: "Airat" }));
    expect(result.username).toBe("airat");
    expect(ports.state.audit.map((e) => e.action)).toContain("human.registered");
  });

  it("refuses a duplicate username", async () => {
    await registerHuman(contextFor(null), { username: "airat" });
    expect(errorOf(await registerHuman(contextFor(null), { username: "airat" }))).toBe(ErrorType.Conflict);
  });

  it("rejects a homoglyph outright, before similarity is even considered", async () => {
    await registerHuman(contextFor(null), { username: "researcher" });
    // The ASCII allow-list is the first layer, and a Cyrillic 'е' never gets past it.
    expect(errorOf(await registerHuman(contextFor(null), { username: "rеsearcher" }))).toBe(
      ErrorType.ValidationFailed,
    );
  });

  it("refuses a name that is confusable within the allowed alphabet", async () => {
    // The second layer earns its place here: these are all valid ASCII, so only the
    // skeleton stops them from sitting beside the original (SPEC §7.3).
    await registerHuman(contextFor(null), { username: "researcher" });
    for (const attempt of ["re-searcher", "re_searcher", "r3searcher"]) {
      const result = await registerHuman(contextFor(null), { username: attempt });
      expect(errorOf(result), attempt).toBe(ErrorType.Conflict);
      expect((result as { error: { extra?: Record<string, unknown> } }).error.extra?.conflicts_with).toBe(
        "researcher",
      );
    }
  });

  it("rejects a reserved name", async () => {
    expect(errorOf(await registerHuman(contextFor(null), { username: "admin" }))).toBe(ErrorType.ValidationFailed);
  });
});

describe("agent registration (SPEC §7.2)", () => {
  it("creates an agent owned by the calling human", async () => {
    const { owner, ctx } = await makeOwner();
    const agent = unwrap(await registerAgent(ctx, { username: "researcher", model: "claude-opus-5" }));
    const record = await ports.principals.findById(agent.principalId);
    expect(record?.kind).toBe("agent");
    expect(record?.ownerPrincipalId).toBe(owner.principalId);
  });

  it("emits agent.created into the outbox, in the same commit", async () => {
    const { ctx } = await makeOwner();
    await registerAgent(ctx, { username: "researcher" });
    expect(ports.state.outbox.map((e) => e.eventType)).toContain("agent.created");
  });

  it("refuses an agent creating another agent", async () => {
    // Otherwise one compromised credential grows an unbounded population and the
    // accountability chain quotas and sanctions rest on is gone (SPEC §60.3).
    const { ctx } = await makeOwner();
    const agent = unwrap(await registerAgent(ctx, { username: "researcher" }));
    const asAgent = contextFor(actorFor(agent.principalId, { kind: "agent", ownerPrincipalId: "OWNER" }));
    expect(errorOf(await registerAgent(asAgent, { username: "spawned" }))).toBe(ErrorType.Forbidden);
  });

  it("refuses an unauthenticated caller", async () => {
    expect(errorOf(await registerAgent(contextFor(null), { username: "x" }))).toBe(ErrorType.Unauthenticated);
  });

  it("rolls the whole registration back when a constraint fails", async () => {
    const { ctx } = await makeOwner();
    await registerAgent(ctx, { username: "researcher" });
    const before = ports.state.principals.size;
    await registerAgent(ctx, { username: "researcher" });
    expect(ports.state.principals.size).toBe(before);
  });
});

describe("tokens (SPEC §42.2, §43.1)", () => {
  it("issues a token that then authenticates", async () => {
    const { owner, ctx } = await makeOwner();
    const issued = unwrap(await issueToken(ctx, { principalId: owner.principalId, name: "cli" }));
    const session = unwrap(await authenticate(ports, issued.token));
    expect(session.actor.principalId).toBe(owner.principalId);
  });

  it("lets an owner issue a token for their agent", async () => {
    const { ctx } = await makeOwner();
    const agent = unwrap(await registerAgent(ctx, { username: "researcher" }));
    const issued = unwrap(await issueToken(ctx, { principalId: agent.principalId, name: "agent" }));
    expect(unwrap(await authenticate(ports, issued.token)).actor.kind).toBe("agent");
  });

  it("refuses to grant a scope the issuer does not hold", async () => {
    // Without this, scope limits are advisory: any token could mint a stronger one.
    const { owner } = await makeOwner();
    const limited = contextFor(actorFor(owner.principalId, { scopes: ["articles:read"] }));
    const result = await issueToken(limited, {
      principalId: owner.principalId,
      name: "escalate",
      scopes: ["articles:publish"],
    });
    expect(errorOf(result)).toBe(ErrorType.Forbidden);
  });

  it("refuses admin scopes to a non-admin", async () => {
    const { owner } = await makeOwner();
    const withAdmin = contextFor(actorFor(owner.principalId, { scopes: ["admin:manage"] }));
    expect(
      errorOf(await issueToken(withAdmin, { principalId: owner.principalId, name: "x", scopes: ["admin:manage"] })),
    ).toBe(ErrorType.Forbidden);
  });

  it("rejects an unknown scope by name", async () => {
    const { owner, ctx } = await makeOwner();
    const result = await issueToken(ctx, { principalId: owner.principalId, name: "x", scopes: ["articles:destroy"] });
    expect(errorOf(result)).toBe(ErrorType.ValidationFailed);
  });

  it("stops accepting a revoked token", async () => {
    const { owner, ctx } = await makeOwner();
    const issued = unwrap(await issueToken(ctx, { principalId: owner.principalId, name: "cli" }));
    await revokeToken(contextFor(actorFor(owner.principalId)), issued.id);
    expect(errorOf(await authenticate(ports, issued.token))).toBe(ErrorType.Unauthenticated);
  });

  it("rejects a token that never existed", async () => {
    expect(errorOf(await authenticate(ports, "orat_sk_live_nonsense"))).toBe(ErrorType.Unauthenticated);
  });

  it("does not write on authentication", async () => {
    // last_used_at inline would make every authenticated read a database write (§42.2).
    const { owner, ctx } = await makeOwner();
    const issued = unwrap(await issueToken(ctx, { principalId: owner.principalId, name: "cli" }));
    await authenticate(ports, issued.token);
    expect(ports.state.tokens.get(issued.id)?.lastUsedAt).toBeNull();
  });
});

describe("agent keys (SPEC §8.2)", () => {
  async function setup() {
    const { ctx } = await makeOwner();
    const agent = unwrap(await registerAgent(ctx, { username: "researcher" }));
    const key = await generateKeyPairForTesting();
    const challenge = unwrap(createKeyChallenge(ctx, agent.principalId));
    return { ctx, agent, key, challenge };
  }

  it("registers a key on a valid challenge response", async () => {
    const { ctx, agent, key, challenge } = await setup();
    const signature = await key.sign(challenge.message);
    const registered = unwrap(
      await registerAgentKey(ctx, {
        agentPrincipalId: agent.principalId,
        publicKey: key.publicKey,
        nonce: challenge.nonce,
        signature,
      }),
    );
    expect(registered.fingerprint).toHaveLength(43);
  });

  it("refuses a signature over a different challenge", async () => {
    const { ctx, agent, key } = await setup();
    const other = await key.sign(keyRegistrationInput("06G2000000000000000000000A", agent.principalId));
    const challenge = unwrap(createKeyChallenge(ctx, agent.principalId));
    const result = await registerAgentKey(ctx, {
      agentPrincipalId: agent.principalId,
      publicKey: key.publicKey,
      nonce: challenge.nonce,
      signature: other,
    });
    expect(errorOf(result)).toBe(ErrorType.ValidationFailed);
  });

  it("refuses a key someone else holds the private half of", async () => {
    const { ctx, agent, key, challenge } = await setup();
    const impostor = await generateKeyPairForTesting();
    const result = await registerAgentKey(ctx, {
      agentPrincipalId: agent.principalId,
      publicKey: key.publicKey,
      nonce: challenge.nonce,
      signature: await impostor.sign(challenge.message),
    });
    expect(errorOf(result)).toBe(ErrorType.ValidationFailed);
    expect(ports.state.audit.some((e) => e.outcome === "denied" && e.reason === "bad-signature")).toBe(true);
  });

  it("refuses a principal who does not own the agent", async () => {
    const { agent, key, challenge } = await setup();
    const stranger = unwrap(await registerHuman(contextFor(null), { username: "stranger" }));
    const result = await registerAgentKey(contextFor(actorFor(stranger.principalId)), {
      agentPrincipalId: agent.principalId,
      publicKey: key.publicKey,
      nonce: challenge.nonce,
      signature: await key.sign(challenge.message),
    });
    expect(errorOf(result)).toBe(ErrorType.Forbidden);
  });

  it("is idempotent for a key already registered to the same agent", async () => {
    const { ctx, agent, key, challenge } = await setup();
    const first = unwrap(
      await registerAgentKey(ctx, {
        agentPrincipalId: agent.principalId,
        publicKey: key.publicKey,
        nonce: challenge.nonce,
        signature: await key.sign(challenge.message),
      }),
    );
    const again = unwrap(createKeyChallenge(ctx, agent.principalId));
    const second = unwrap(
      await registerAgentKey(ctx, {
        agentPrincipalId: agent.principalId,
        publicKey: key.publicKey,
        nonce: again.nonce,
        signature: await key.sign(again.message),
      }),
    );
    expect(second.id).toBe(first.id);
  });

  it("revokes, leaving the record in place for verifying older signatures", async () => {
    const { ctx, agent, key, challenge } = await setup();
    const registered = unwrap(
      await registerAgentKey(ctx, {
        agentPrincipalId: agent.principalId,
        publicKey: key.publicKey,
        nonce: challenge.nonce,
        signature: await key.sign(challenge.message),
      }),
    );
    expect(unwrap(await revokeAgentKey(ctx, registered.id, "rotated"))).toBe(true);
    const after = await ports.keys.findById(registered.id);
    expect(after?.status).toBe("revoked");
    expect(after?.publicKey).toBe(key.publicKey);
  });
});

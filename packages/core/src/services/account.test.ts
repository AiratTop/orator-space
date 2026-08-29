import { beforeEach, describe, expect, it } from "vitest";
import { ErrorType } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { OWNER_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { issueToken, registerAgent, registerHuman, revokeToken } from "./identity.js";
import { accountView, endSession, removePasskey, sessionActor, setAgentStatus } from "./account.js";

let ports: ReturnType<typeof createMemoryPorts>;

const contextFor = (actor: Actor | null): RequestContext => ({
  ports,
  requestId: "REQ",
  actor,
  tokenId: null,
  ipHash: null,
  userAgent: null,
  audience: "human_web",
});

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};
const errorOf = (result: { ok: boolean; error?: { type: string } }) => {
  if (result.ok) throw new Error("expected failure");
  return result.error!.type;
};

async function ownerWithAgent(username = "airat", agentName = "airat-bot") {
  const owner = unwrap(await registerHuman(contextFor(null), { username }));
  const principal = (await ports.principals.findById(owner.principalId))!;
  const ctx = contextFor(sessionActor(principal));
  const agent = unwrap(await registerAgent(ctx, { username: agentName, model: "claude-opus-5" }));
  return { owner, agent, ctx };
}

beforeEach(() => {
  ports = createMemoryPorts();
});

describe("the actor a session stands for", () => {
  it("carries what the account's own token carries, and no admin scope", async () => {
    const owner = unwrap(await registerHuman(contextFor(null), { username: "airat" }));
    const actor = sessionActor((await ports.principals.findById(owner.principalId))!);
    expect([...actor.scopes].sort()).toEqual([...OWNER_PRESET].sort());
    expect(actor.scopes.some((scope) => scope.startsWith("admin:"))).toBe(false);
  });
});

describe("the account view", () => {
  it("shows the agents a person owns, with their tokens", async () => {
    const { agent, ctx } = await ownerWithAgent();
    await issueToken(ctx, { principalId: agent.principalId, name: "deploy" });

    const view = unwrap(await accountView(ctx, null));
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]!.principal.username).toBe("airat-bot");
    expect(view.agents[0]!.tokens.map((t) => t.name)).toEqual(["deploy"]);
  });

  it("never carries the token itself, only the prefix it was issued with", async () => {
    const { ctx, agent } = await ownerWithAgent();
    const issued = unwrap(await issueToken(ctx, { principalId: agent.principalId, name: "deploy" }));

    const view = unwrap(await accountView(ctx, null));
    const summary = view.agents[0]!.tokens[0]!;
    expect(summary.prefix).toBe(issued.token.slice(0, summary.prefix.length));
    expect(JSON.stringify(view)).not.toContain(issued.token);
  });

  it("drops a revoked token from the list rather than showing it as revoked", async () => {
    const { ctx, agent } = await ownerWithAgent();
    const issued = unwrap(await issueToken(ctx, { principalId: agent.principalId, name: "deploy" }));

    expect(unwrap(await revokeToken(ctx, issued.id))).toBe(true);
    const view = unwrap(await accountView(ctx, null));
    expect(view.agents[0]!.tokens).toEqual([]);
  });

  it("keeps a suspended agent visible to its owner", async () => {
    const { ctx, agent } = await ownerWithAgent();
    await setAgentStatus(ctx, agent.principalId, "suspended");

    const view = unwrap(await accountView(ctx, null));
    expect(view.agents[0]!.principal.status).toBe("suspended");
  });

  it("does not show one person's agents to another", async () => {
    await ownerWithAgent();
    const other = unwrap(await registerHuman(contextFor(null), { username: "someone-else" }));
    const otherCtx = contextFor(sessionActor((await ports.principals.findById(other.principalId))!));

    expect(unwrap(await accountView(otherCtx, null)).agents).toEqual([]);
  });
});

describe("revoking a token", () => {
  /*
   * The asymmetry this closes: `issueToken` has always minted tokens for an owned agent,
   * and revocation only ever looked at the caller's own principal — so a human could give
   * their agent a credential and had no way to take it back.
   */
  it("covers a token belonging to an agent the caller owns", async () => {
    const { ctx, agent } = await ownerWithAgent();
    const issued = unwrap(await issueToken(ctx, { principalId: agent.principalId, name: "deploy" }));

    expect(unwrap(await revokeToken(ctx, issued.id))).toBe(true);
    expect(unwrap(await accountView(ctx, null)).agents[0]!.tokens).toEqual([]);
  });

  it("answers not-found for somebody else's token, rather than forbidden", async () => {
    const { ctx: mine, agent } = await ownerWithAgent();
    const issued = unwrap(await issueToken(mine, { principalId: agent.principalId, name: "deploy" }));

    const other = unwrap(await registerHuman(contextFor(null), { username: "someone-else" }));
    const theirs = contextFor(sessionActor((await ports.principals.findById(other.principalId))!));

    // Not Forbidden: 403 would confirm the token exists to somebody who may not touch it.
    expect(errorOf(await revokeToken(theirs, issued.id))).toBe(ErrorType.NotFound);
  });

  it("is idempotent, and does not write a second audit row", async () => {
    const { ctx, agent } = await ownerWithAgent();
    const issued = unwrap(await issueToken(ctx, { principalId: agent.principalId, name: "deploy" }));

    await revokeToken(ctx, issued.id);
    await revokeToken(ctx, issued.id);
    expect(ports.state.audit.filter((entry) => entry.action === "token.revoked")).toHaveLength(1);
  });
});

describe("stopping an agent", () => {
  it("suspends and restores, and records both", async () => {
    const { ctx, agent } = await ownerWithAgent();

    expect(unwrap(await setAgentStatus(ctx, agent.principalId, "suspended"))).toBe(true);
    expect((await ports.principals.findById(agent.principalId))!.status).toBe("suspended");
    expect(unwrap(await setAgentStatus(ctx, agent.principalId, "active"))).toBe(true);
    expect((await ports.principals.findById(agent.principalId))!.status).toBe("active");

    const actions = ports.state.audit.map((entry) => entry.action);
    expect(actions).toContain("agent.suspended");
    expect(actions).toContain("agent.restored");
  });

  it("leaves the agent's tokens alone, because suspension is reversible", async () => {
    const { ctx, agent } = await ownerWithAgent();
    await issueToken(ctx, { principalId: agent.principalId, name: "deploy" });
    await setAgentStatus(ctx, agent.principalId, "suspended");

    // Still there, and still listed: re-issuing credentials to un-pause an agent would be
    // a much larger action than the one the owner asked for.
    expect(unwrap(await accountView(ctx, null)).agents[0]!.tokens).toHaveLength(1);
  });

  it("refuses an agent somebody else owns, as not-found", async () => {
    const { agent } = await ownerWithAgent();
    const other = unwrap(await registerHuman(contextFor(null), { username: "someone-else" }));
    const theirs = contextFor(sessionActor((await ports.principals.findById(other.principalId))!));

    expect(errorOf(await setAgentStatus(theirs, agent.principalId, "suspended"))).toBe(ErrorType.NotFound);
  });

  it("refuses to reach a human principal through the agent switch", async () => {
    const { ctx, owner } = await ownerWithAgent();
    expect(errorOf(await setAgentStatus(ctx, owner.principalId, "suspended"))).toBe(ErrorType.NotFound);
  });
});

describe("sessions", () => {
  const openSession = (principalId: string, id: string, userAgent: string) =>
    ports.sessions.insert({
      id: id as never,
      principalId: principalId as never,
      tokenHash: `hash-${id}`,
      userAgent,
      ipHash: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
    });

  it("marks the session the page is being rendered for", async () => {
    const { ctx, owner } = await ownerWithAgent();
    await ports.db.commit([openSession(owner.principalId, "S1", "Firefox"), openSession(owner.principalId, "S2", "Safari")]);

    const view = unwrap(await accountView(ctx, "S1"));
    expect(view.sessions.map((s) => [s.id, s.current])).toEqual([
      ["S1", true],
      ["S2", false],
    ]);
  });

  it("ends one session and leaves the other", async () => {
    const { ctx, owner } = await ownerWithAgent();
    await ports.db.commit([openSession(owner.principalId, "S1", "Firefox"), openSession(owner.principalId, "S2", "Safari")]);

    expect(unwrap(await endSession(ctx, "S2"))).toBe(true);
    expect(unwrap(await accountView(ctx, "S1")).sessions.map((s) => s.id)).toEqual(["S1"]);
  });

  it("refuses a session belonging to somebody else", async () => {
    const { ctx } = await ownerWithAgent();
    const other = unwrap(await registerHuman(contextFor(null), { username: "someone-else" }));
    await ports.db.commit([openSession(other.principalId, "S9", "Firefox")]);

    expect(errorOf(await endSession(ctx, "S9"))).toBe(ErrorType.NotFound);
  });

  it("hides an expired session, which the adapter deliberately does not filter", async () => {
    const { ctx, owner } = await ownerWithAgent();
    await ports.db.commit([
      ports.sessions.insert({
        id: "S-OLD" as never,
        principalId: owner.principalId as never,
        tokenHash: "hash-old",
        userAgent: "Firefox",
        ipHash: null,
        createdAt: "2020-01-01T00:00:00.000Z",
        lastSeenAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-02-01T00:00:00.000Z",
        revokedAt: null,
      }),
    ]);

    expect(unwrap(await accountView(ctx, null)).sessions).toEqual([]);
  });
});

/**
 * SPEC §61.1, §42.2 — what a moderator's session may and may not do.
 *
 * Found by opening the page: a moderator could sign in, reach §61.1's queue and be refused
 * by it, because `canModerate` wants `admin:moderate` and a session carried none. An
 * obligation with a surface that does not work is worse than one with no surface.
 */
describe("a moderator's session", () => {
  const asRole = async (role: "user" | "moderator" | "admin") => {
    const registered = unwrap(await registerHuman(contextFor(null), { username: `who-${role}` }));
    const principal = (await ports.principals.findById(registered.principalId))!;
    return sessionActor({ ...principal, platformRole: role });
  };

  it("carries admin:moderate, so the queue it is shown actually answers", async () => {
    expect((await asRole("moderator")).scopes).toContain("admin:moderate");
    expect((await asRole("admin")).scopes).toContain("admin:moderate");
  });

  it("and an ordinary account's does not", async () => {
    expect((await asRole("user")).scopes).not.toContain("admin:moderate");
  });

  it("but never admin:manage, which §61.1's queue does not need", async () => {
    // A scope handed out because it was adjacent is how a role stops meaning anything.
    expect((await asRole("admin")).scopes).not.toContain("admin:manage");
  });

  it("and cannot mint an admin-scoped token, because that guard is elsewhere", async () => {
    const registered = unwrap(await registerHuman(contextFor(null), { username: "mod-issuer" }));
    const principal = (await ports.principals.findById(registered.principalId))!;
    const ctx = contextFor(sessionActor({ ...principal, platformRole: "moderator" }));

    const issued = await issueToken(ctx, {
      principalId: registered.principalId,
      name: "wide",
      scopes: ["admin:moderate"],
    });

    // §42.2 — only an administrator may grant an admin scope. That check does the work the
    // incomplete actor was standing in for, and does it in one place.
    expect(errorOf(issued)).toBe(ErrorType.Forbidden);
  });
});


/**
 * SPEC §9.1, §9.2 — a passkey can be taken away, and the last one cannot.
 *
 * §9.2 listed `DELETE /v1/auth/credentials/{id}` from the first version of the document and
 * nothing implemented it, so the only remedy for an authenticator somebody else is holding
 * was to close the account — which destroys the work rather than the key. §9.1's refusal to
 * delete a last credential has waited just as long, for the reason that it had nothing to
 * point at: until §9.3 there was no backup sign-in method for it to require.
 */
describe("passkeys", () => {
  const addPasskey = (principalId: string, id: string, label: string | null = null) =>
    ports.credentials.insert({
      id: id as never,
      principalId: principalId as never,
      credentialId: `cred-${id}`,
      publicKey: `key-${id}`,
      signCount: 0,
      transports: null,
      aaguid: null,
      label,
      backedUp: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

  const linkTelegram = (principalId: string) =>
    ports.telegram.upsertAccount({
      principalId: principalId as never,
      telegramUserId: "tg-1",
      chatId: "chat-1",
      username: null,
      linkedAt: "2026-01-01T00:00:00.000Z",
    });

  it("lists what a person holds, without the key material", async () => {
    const { ctx, owner } = await ownerWithAgent();
    await ports.db.commit([addPasskey(owner.principalId, "P1", "phone")]);

    const view = unwrap(await accountView(ctx, null));
    expect(view.passkeys.map((p) => [p.id, p.label])).toEqual([["P1", "phone"]]);
    expect(JSON.stringify(view.passkeys)).not.toContain("key-P1");
    expect(JSON.stringify(view.passkeys)).not.toContain("cred-P1");
  });

  it("removes one and leaves the other", async () => {
    const { ctx, owner } = await ownerWithAgent();
    await ports.db.commit([addPasskey(owner.principalId, "P1"), addPasskey(owner.principalId, "P2")]);

    expect(unwrap(await removePasskey(ctx, "P2")).remaining).toBe(1);
    expect(unwrap(await accountView(ctx, null)).passkeys.map((p) => p.id)).toEqual(["P1"]);
  });

  it("refuses the last one when there is no other way in", async () => {
    const { ctx, owner } = await ownerWithAgent();
    await ports.db.commit([addPasskey(owner.principalId, "P1")]);

    expect(errorOf(await removePasskey(ctx, "P1"))).toBe(ErrorType.Conflict);
    expect(unwrap(await accountView(ctx, null)).passkeys).toHaveLength(1);
  });

  it("allows the last one once a chat is bound (§9.3)", async () => {
    const { ctx, owner } = await ownerWithAgent();
    await ports.db.commit([addPasskey(owner.principalId, "P1"), linkTelegram(owner.principalId)]);

    expect(unwrap(await accountView(ctx, null)).backupChannel).toBe(true);
    expect(unwrap(await removePasskey(ctx, "P1")).remaining).toBe(0);
  });

  it("refuses a passkey belonging to somebody else, and does not delete it", async () => {
    const { ctx } = await ownerWithAgent();
    const other = unwrap(await registerHuman(contextFor(null), { username: "someone-else" }));
    await ports.db.commit([addPasskey(other.principalId, "P9")]);

    expect(errorOf(await removePasskey(ctx, "P9"))).toBe(ErrorType.NotFound);
    expect(await ports.credentials.listFor(other.principalId)).toHaveLength(1);
  });

  it("records the removal in the audit log (§62)", async () => {
    const { ctx, owner } = await ownerWithAgent();
    await ports.db.commit([addPasskey(owner.principalId, "P1"), addPasskey(owner.principalId, "P2")]);
    await removePasskey(ctx, "P2");

    const entry = ports.state.audit.find((row) => row.action === "credential.removed");
    expect(entry?.targetId).toBe("P2");
    expect(entry?.actorPrincipalId).toBe(owner.principalId);
  });
});

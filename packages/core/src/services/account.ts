import { ErrorType, type OratorId } from "@orator/protocol";
import type { Actor } from "../identity/authz.js";
import { canManageAgent } from "../identity/authz.js";
import { OWNER_PRESET, type Scope } from "../identity/scopes.js";
import { isExpired } from "../identity/tokens.js";
import type { KeyRecord, OpenSession, PrincipalRecord, TokenRecord } from "../ports/index.js";
import { fail, journal, ok, type AccountContext, type Result } from "./context.js";

/**
 * What a person can do with their own account from a browser (SPEC §49.2, §7.2, §42.2).
 *
 * The gap this closes was found by using the product: an account could be created and
 * signed into, and then there was nothing to do with it. Every operation already existed
 * as a REST endpoint, which is the point — none of this is new domain work, and none of it
 * is a second implementation. `identity.ts` still owns registering an agent, issuing a
 * token and editing a profile; this module is the read model those writes are made from,
 * plus the two operations only a browser has ever needed (ending a session, suspending an
 * agent one owns).
 */

export interface TokenSummary {
  id: OratorId;
  name: string;
  /** The visible half. The token itself existed once, in one response (§42.2). */
  prefix: string;
  scopes: readonly string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface KeySummary {
  id: OratorId;
  fingerprint: string;
  label: string | null;
  createdAt: string;
}

export interface AgentView {
  principal: PrincipalRecord;
  tokens: TokenSummary[];
  keys: KeySummary[];
}

export interface SessionView extends OpenSession {
  /** The one the page is being rendered for. Ending it is signing out, and says so. */
  current: boolean;
}

/*
 * The reading list is not here any more, and neither is its count.
 *
 * It was a tab, so the strip carried a number like every other tab. It has its own address
 * now (ADR 0011, §49.2): a page that lists the articles does not need to be told how many
 * there are, and this saved a query on every load of a page about credentials.
 */
/**
 * A passkey as the person holding it sees it (SPEC §9.1, §9.2).
 *
 * No public key and no credential id. Neither is a secret and neither tells a person
 * anything — what tells them which authenticator this is are the dates, whether it is
 * synced to a keychain or bound to one device, and the label if one was given. A page that
 * printed the credential id would be inviting somebody to compare two base64url strings in
 * order to decide which of them to delete.
 */
export interface PasskeyView {
  id: OratorId;
  label: string | null;
  /** Synced to a provider's keychain, rather than living on one device only. */
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AccountView {
  principal: PrincipalRecord;
  tokens: TokenSummary[];
  agents: AgentView[];
  sessions: SessionView[];
  passkeys: PasskeyView[];
  /**
   * Whether a second way in exists (SPEC §9.1, §9.3).
   *
   * The page needs it for the same reason the service does: a control that would be refused
   * should say so before it is pressed, not after.
   */
  backupChannel: boolean;
}

/**
 * The actor a browser session stands for (SPEC §9.1, §42.2, §61.1).
 *
 * `OWNER_PRESET` — what the account's own first token carries, so a session can do what its
 * owner can do and nothing more.
 *
 * **Plus `admin:moderate` for a moderator, which reverses an earlier decision here.** This
 * withheld every admin scope from a session on the reasoning that "an admin scope reachable
 * from a cookie is an admin scope reachable from a link somebody clicked". That reasoning
 * was about CSRF and it is answered elsewhere and better: the session cookie is
 * `SameSite=Lax` and every write from a page is refused without a matching `Origin` (§57.3).
 * What it actually achieved was a moderator who could sign in, see §61.1's queue, and be
 * refused by it — an obligation with a surface that does not work, which is worse than one
 * with no surface at all.
 *
 * The escalation guard it was standing in for is real and stays where it belongs:
 * `issueToken` refuses to mint an admin scope unless the issuer is an administrator, so a
 * moderator's session still cannot produce an admin-scoped token. That check does the work,
 * and it does it in one place rather than by leaving the actor quietly incomplete.
 *
 * `admin:manage` is not granted. Whatever it comes to gate, it is not §61.1's queue, and a
 * scope handed out because it was adjacent is how a role stops meaning anything.
 */
export function sessionActor(principal: PrincipalRecord): Actor {
  const moderating = principal.platformRole === "moderator" || principal.platformRole === "admin";
  return {
    principalId: principal.id,
    kind: principal.kind,
    platformRole: principal.platformRole,
    scopes: (moderating ? [...OWNER_PRESET, "admin:moderate"] : OWNER_PRESET) as readonly Scope[],
    status: principal.status,
    trustLevel: principal.trustLevel ?? 1,
    systemAccount: principal.systemAccount,
    ...(principal.ownerPrincipalId === undefined ? {} : { ownerPrincipalId: principal.ownerPrincipalId }),
  };
}

/** Revoked and expired tokens are not shown: the list is what there is to act on. */
const liveTokens = (tokens: TokenRecord[], now: Date): TokenSummary[] =>
  tokens
    .filter((token) => token.revokedAt === null && !isExpired(token.expiresAt, now))
    .map((token) => ({
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      scopes: token.scopes,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
      expiresAt: token.expiresAt,
    }));

const liveKeys = (keys: KeyRecord[]): KeySummary[] =>
  keys
    .filter((key) => key.status === "active")
    .map((key) => ({ id: key.id, fingerprint: key.fingerprint, label: key.label, createdAt: key.createdAt }));

/**
 * Everything `/settings` renders, in one call.
 *
 * One query per agent for tokens and one for keys, which is a fan-out — and an acceptable
 * one, because §60.3 bounds the number of agents a person may own and this is a page a
 * person opens rather than a path an agent hammers. If the agent quota ever rises to where
 * this matters, the fix is a batched read on the repo, not a cache here.
 */
export async function accountView(
  ctx: AccountContext,
  currentSessionId: string | null,
): Promise<Result<AccountView>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const principal = await ctx.ports.principals.findById(actor.principalId);
  if (principal === null || principal.status === "deleted") {
    return fail(ErrorType.NotFound, "Principal not found");
  }

  const now = ctx.ports.clock.now();
  const [ownTokens, owned, sessions, credentials, telegram] = await Promise.all([
    ctx.ports.tokens.listFor(principal.id),
    // Suspended agents included: this is the owner's view, and an agent that has been
    // stopped is exactly the row its owner needs to see in order to start it again.
    ctx.ports.principals.listAgentsOwnedBy(principal.id),
    ctx.ports.sessions.listFor(principal.id),
    ctx.ports.credentials.listFor(principal.id),
    ctx.ports.telegram.findByPrincipal(principal.id),
  ]);

  const agents = await Promise.all(
    owned
      .filter((agent) => agent.status !== "deleted")
      .map(async (agent): Promise<AgentView> => {
        const [tokens, keys] = await Promise.all([
          ctx.ports.tokens.listFor(agent.id),
          ctx.ports.keys.listFor(agent.id),
        ]);
        return { principal: agent, tokens: liveTokens(tokens, now), keys: liveKeys(keys) };
      }),
  );

  return ok({
    principal,
    tokens: liveTokens(ownTokens, now),
    agents,
    // The clock filters expiry rather than the adapter, so a test can move time (§68).
    sessions: sessions
      .filter((session) => Date.parse(session.expiresAt) > now.getTime())
      .map((session) => ({ ...session, current: session.id === currentSessionId })),
    passkeys: credentials.map((credential) => ({
      id: credential.id,
      label: credential.label,
      backedUp: credential.backedUp,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
    })),
    backupChannel: telegram !== null,
  });
}

/**
 * Removes one passkey (SPEC §9.1, §9.2, §62).
 *
 * §9.2 listed this endpoint from the beginning and nothing implemented it, so the only
 * answer to a lost or compromised authenticator was to close the account. That is the wrong
 * shape of answer: the credential keeps existing on a device somebody else may be holding,
 * and closing the account destroys the work rather than the key.
 *
 * **The last one is refused unless a second way in exists.** §9.1 says so, and until §9.3
 * there was no second way for the rule to point at — which is why the rule has waited. A
 * person who deletes their only credential with no chat bound has no path back into the
 * account, and no support desk here to ask.
 *
 * Ownership comes from the listing, like `endSession` above: a credential that is not in
 * this principal's list is not this principal's, so no argument to this function can reach
 * somebody else's key. The write is scoped again on the way out.
 */
export async function removePasskey(
  ctx: AccountContext,
  credentialId: string,
): Promise<Result<{ remaining: number }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const credentials = await ctx.ports.credentials.listFor(actor.principalId);
  if (!credentials.some((credential) => credential.id === credentialId)) {
    return fail(ErrorType.NotFound, "Passkey not found");
  }

  if (credentials.length === 1) {
    const telegram = await ctx.ports.telegram.findByPrincipal(actor.principalId);
    if (telegram === null) {
      return fail(
        ErrorType.Conflict,
        "That is the only way into this account",
        "Add a second passkey, or connect Telegram, before removing this one. There is no " +
          "way to restore an account whose last credential is gone.",
      );
    }
  }

  await ctx.ports.db.commit([
    ctx.ports.credentials.deleteOne(credentialId, actor.principalId),
    journal(ctx, "credential.removed", { type: "credential", id: credentialId }, "success", null),
  ]);
  return ok({ remaining: credentials.length - 1 });
}

/**
 * Ends one session (SPEC §9.1).
 *
 * Ownership is established by the listing rather than by a lookup: `listFor` returns this
 * principal's open sessions, so a session id that is not in it is not this principal's, and
 * there is no path here that can revoke somebody else's.
 */
export async function endSession(ctx: AccountContext, sessionId: string): Promise<Result<true>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const sessions = await ctx.ports.sessions.listFor(actor.principalId);
  if (!sessions.some((session) => session.id === sessionId)) {
    return fail(ErrorType.NotFound, "Session not found");
  }

  const at = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([
    ctx.ports.sessions.revoke(sessionId, at),
    journal(ctx, "session.revoked", { type: "session", id: sessionId }, "success", null),
  ]);
  return ok(true);
}

/**
 * Stops an agent, or starts it again (SPEC §7.2, §43.2).
 *
 * §7.2 makes a person accountable for every agent they own, and accountability without a
 * way to stop the thing is a word. `suspended` and `active` only: `deleted` is closure and
 * erasure (§23.3, §23.5), which are not a toggle on a settings page.
 *
 * The agent's tokens are left alone. Suspension is reversible and revocation is not, and an
 * owner pausing an agent for an afternoon should not have to re-issue its credentials —
 * authentication already refuses a token whose principal is not active.
 */
export async function setAgentStatus(
  ctx: AccountContext,
  agentPrincipalId: string,
  status: "active" | "suspended",
): Promise<Result<true>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const agent = await ctx.ports.principals.findById(agentPrincipalId);
  if (agent === null || agent.kind !== "agent" || agent.status === "deleted") {
    return fail(ErrorType.NotFound, "Agent not found");
  }
  if (agent.ownerPrincipalId === undefined) return fail(ErrorType.NotFound, "Agent not found");

  const decision = canManageAgent(actor, agent.ownerPrincipalId);
  if (!decision.allowed) {
    // Not found rather than forbidden: a caller who may not manage this agent has no
    // business learning which agents exist.
    return fail(ErrorType.NotFound, "Agent not found");
  }
  if (agent.status === status) return ok(true);

  const at = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([
    ctx.ports.principals.setStatus(agent.id, status, at),
    journal(
      ctx,
      status === "suspended" ? "agent.suspended" : "agent.restored",
      { type: "principal", id: agent.id },
      "success",
      null,
    ),
  ]);
  return ok(true);
}

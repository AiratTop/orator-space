import type { Scope } from "./scopes.js";
import { hasScope } from "./scopes.js";

/**
 * Authorisation (SPEC §43.2, §43.4).
 *
 * Decided here, in the domain, rather than in each HTTP adapter. REST, MCP and the web
 * app must reach the same verdict for the same question; three implementations of that
 * rule would diverge, and the divergence would be a security bug rather than a bug.
 */

export type PlatformRole = "user" | "moderator" | "admin";

/** Who is making the call, and with what authority. */
export interface Actor {
  principalId: string;
  kind: "human" | "agent";
  platformRole: PlatformRole;
  scopes: readonly Scope[];
  /** Set when the actor is an agent: the human accountable for it (SPEC §7.2). */
  ownerPrincipalId?: string;
  status: "active" | "suspended" | "deleted";
  /**
   * SPEC §60.2 — 0 to 3, deciding the limit multiplier and the indexing threshold.
   *
   * Carried on the actor rather than read when a quota is checked. Authentication has the
   * principal in hand already, and a second read on the write path of every publish is the
   * cost §59 was trying to avoid by not putting the counter in D1 in the first place.
   */
  trustLevel: number;
}

/** The ownership facts a decision needs, independent of which table the resource lives in. */
export interface ResourceOwnership {
  authorPrincipalId: string;
  /** Owner of the authoring agent, when the author is an agent. */
  authorOwnerPrincipalId?: string;
}

export type Decision = { allowed: true } | { allowed: false; reason: DenialReason };

export type DenialReason =
  | "suspended"
  | "insufficient-scope"
  | "not-owner"
  | "cross-agent"
  | "requires-moderator";

const allow: Decision = { allowed: true };
const deny = (reason: DenialReason): Decision => ({ allowed: false, reason });

/**
 * May the actor modify this resource?
 *
 * An agent may act on its own resources only. Its owner may act on them too, but a
 * sibling agent under the same owner may not: that bound keeps a compromised agent from
 * reaching everything its owner has (§43.2).
 */
export function canModify(actor: Actor, resource: ResourceOwnership, scope: Scope): Decision {
  if (actor.status !== "active") return deny("suspended");
  if (!hasScope(actor.scopes, scope)) return deny("insufficient-scope");

  if (resource.authorPrincipalId === actor.principalId) return allow;

  // A human acting on a resource authored by an agent they own.
  if (actor.kind === "human" && resource.authorOwnerPrincipalId === actor.principalId) return allow;

  if (actor.platformRole === "moderator" || actor.platformRole === "admin") {
    return hasScope(actor.scopes, "admin:moderate") ? allow : deny("insufficient-scope");
  }

  // Same owner, different agent — deliberately refused, and worth its own reason so the
  // API can say why rather than returning a bare 403.
  if (
    actor.kind === "agent" &&
    actor.ownerPrincipalId !== undefined &&
    actor.ownerPrincipalId === resource.authorOwnerPrincipalId
  ) {
    return deny("cross-agent");
  }

  return deny("not-owner");
}

/** May the actor create a resource of this kind at all? */
export function canCreate(actor: Actor, scope: Scope): Decision {
  if (actor.status !== "active") return deny("suspended");
  return hasScope(actor.scopes, scope) ? allow : deny("insufficient-scope");
}

/** Moderation actions require the role and the scope, never one alone. */
export function canModerate(actor: Actor): Decision {
  if (actor.status !== "active") return deny("suspended");
  if (actor.platformRole !== "moderator" && actor.platformRole !== "admin") {
    return deny("requires-moderator");
  }
  return hasScope(actor.scopes, "admin:moderate") ? allow : deny("insufficient-scope");
}

/**
 * May the actor manage this agent — rotate its keys, issue its tokens, change its profile?
 * Only the accountable human, or an administrator. An agent cannot escalate itself.
 */
export function canManageAgent(actor: Actor, agentOwnerPrincipalId: string): Decision {
  if (actor.status !== "active") return deny("suspended");
  if (!hasScope(actor.scopes, "agents:manage")) return deny("insufficient-scope");
  if (actor.kind === "human" && actor.principalId === agentOwnerPrincipalId) return allow;
  if (actor.platformRole === "admin") return allow;
  return deny("not-owner");
}

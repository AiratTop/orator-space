import { ErrorType, idTimestamp, SCHEMA_VERSION, type OratorId } from "@orator/protocol";
import { ConstraintViolation, type PrincipalRecord } from "../ports/index.js";
import type { Actor, DenialReason } from "../identity/authz.js";
import { canManageAgent } from "../identity/authz.js";
import { canonicalizeUsername } from "../identity/username.js";
import {
  AGENT_PRESET,
  DEFAULT_SCOPES,
  hasScope,
  isAdminScope,
  OWNER_PRESET,
  parseScopes,
  type Scope,
} from "../identity/scopes.js";
import { generateToken, sha256Hex, isExpired } from "../identity/tokens.js";
import { fingerprint, keyRegistrationInput, verifySignature } from "../identity/keys.js";
import {
  fail,
  journal,
  ok,
  withinQuota,
  type AccountContext,
  type Ports,
  type Result,
} from "./context.js";

const denialToError = (reason: DenialReason) =>
  reason === "insufficient-scope"
    ? ErrorType.InsufficientScope
    : reason === "suspended"
      ? ErrorType.Forbidden
      : ErrorType.Forbidden;

const DENIAL_DETAIL: Record<DenialReason, string> = {
  suspended: "This principal is suspended.",
  "insufficient-scope": "The token does not carry the required scope.",
  "not-owner": "This principal does not own the resource.",
  "cross-agent": "An agent cannot act on a sibling agent's resources, even under the same owner.",
  "requires-moderator": "This action requires a moderator or administrator.",
};

async function usernameAvailable(
  ports: Pick<Ports, "principals">,
  username: string,
  skeleton: string,
): Promise<Result<true>> {
  if (await ports.principals.findByUsername(username)) {
    return fail(ErrorType.Conflict, "Username is taken");
  }
  const confusable = await ports.principals.findBySkeleton(skeleton);
  if (confusable) {
    // Named explicitly: "taken" would be baffling when the two names look different to
    // the person typing but identical to everyone reading (SPEC §7.3).
    return fail(
      ErrorType.Conflict,
      "Username is too similar to an existing one",
      `@${confusable.username} already exists and is visually confusable with this name.`,
      { conflicts_with: confusable.username },
    );
  }
  return ok(true);
}

export interface RegisterHumanInput {
  username: string;
  displayName?: string | null;
  email?: string | null;
}

/**
 * Registers a human and returns a first token.
 *
 * The token is part of the response because otherwise the account is inert: issuing a
 * token requires authentication, and a newly registered principal has nothing to
 * authenticate with. Until passkey sign-in exists (Phase 5) this is the only way in, and
 * it stays afterwards because an API-first platform should let a caller register and act
 * without a browser round trip.
 *
 * Registration therefore mints a credential, which makes it a rate-limiting target
 * (SPEC §59.2, applied in Phase 8).
 */
export async function registerHuman(
  ctx: AccountContext,
  input: RegisterHumanInput,
): Promise<Result<{ principalId: OratorId; username: string; token: string; scopes: Scope[] }>> {
  const name = canonicalizeUsername(input.username);
  if ("error" in name) {
    return fail(ErrorType.ValidationFailed, "Invalid username", name.error, { field: "username" });
  }

  const available = await usernameAvailable(ctx.ports, name.username, name.skeleton);
  if (!available.ok) return available;

  const id = ctx.ports.ids.next();
  const tokenId = ctx.ports.ids.next();
  const createdAt = ctx.ports.clock.now().toISOString();
  const generated = await generateToken();

  try {
    // Principal, account and first token in one commit: an account that exists without a
    // way to reach it would be a state the API cannot recover from.
    await ctx.ports.db.commit([
      ctx.ports.principals.insertPrincipal({
        id,
        kind: "human",
        username: name.username,
        usernameSkeleton: name.skeleton,
        displayName: input.displayName ?? null,
        createdAt,
      }),
      ctx.ports.principals.insertHumanAccount(id, input.email ?? null, createdAt),
      ctx.ports.tokens.insert({
        id: tokenId,
        principalId: id,
        name: "initial",
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
        scopes: OWNER_PRESET,
        expiresAt: null,
        createdAt,
      }),
      journal({ ...ctx, actor: null }, "human.registered", { type: "principal", id }, "success", null),
    ]);
  } catch (error) {
    // The check above narrows the race window but cannot close it: uniqueness is the
    // database's to enforce, and two simultaneous registrations reach it together.
    if (error instanceof ConstraintViolation && error.constraint === "unique") {
      return fail(ErrorType.Conflict, "Username is taken");
    }
    throw error;
  }

  return ok({ principalId: id, username: name.username, token: generated.token, scopes: [...OWNER_PRESET] });
}

export interface RegisterAgentInput {
  username: string;
  displayName?: string | null;
  model?: string | null;
  provider?: string | null;
}

/**
 * Creates an agent owned by the calling human (SPEC §7.2).
 *
 * An agent cannot create an agent. Allowing it would let one compromised credential grow
 * an unbounded population, and would break the accountability chain that quotas, sanctions
 * and sybil weighting all rest on (§60.3).
 */
export async function registerAgent(
  ctx: AccountContext,
  input: RegisterAgentInput,
): Promise<Result<{ principalId: OratorId; username: string }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");
  if (actor.kind !== "human") {
    return fail(
      ErrorType.Forbidden,
      "Only a human principal can create an agent",
      "Every agent has an accountable owner; an agent creating agents would break that chain.",
    );
  }

  const decision = canManageAgent(actor, actor.principalId);
  if (!decision.allowed) {
    return fail(denialToError(decision.reason), "Not permitted", DENIAL_DETAIL[decision.reason]);
  }

  const name = canonicalizeUsername(input.username);
  if ("error" in name) {
    return fail(ErrorType.ValidationFailed, "Invalid username", name.error, { field: "username" });
  }
  const available = await usernameAvailable(ctx.ports, name.username, name.skeleton);
  if (!available.ok) return available;

  // §60.3 — the sybil limit, and the one quota charged to the owner by construction: the
  // agent being created has no principal to charge, and would have a fresh allowance if
  // it did.
  const allowance = await withinQuota(ctx, "agents");
  if (!allowance.ok) return allowance;

  const id = ctx.ports.ids.next();
  const createdAt = ctx.ports.clock.now().toISOString();

  try {
    await ctx.ports.db.commit([
      ctx.ports.principals.insertPrincipal({
        id,
        kind: "agent",
        username: name.username,
        usernameSkeleton: name.skeleton,
        /*
         * Null, not `@username`.
         *
         * The default used to invent a display name by gluing an `@` to the username, and
         * every surface that shows both then showed the same word twice — the byline read
         * "@p7-analyst (@p7-analyst)". A display name is optional (§7.2) precisely because
         * an agent may not have one worth showing, and the fallback belongs in the reader's
         * view rather than in the row.
         */
        displayName: input.displayName ?? null,
        createdAt,
      }),
      ctx.ports.principals.insertAgent({
        principalId: id,
        ownerPrincipalId: actor.principalId as OratorId,
        model: input.model ?? null,
        provider: input.provider ?? null,
        createdAt,
      }),
      ctx.ports.outbox.enqueue({
        id: ctx.ports.ids.next(),
        eventType: "agent.created",
        aggregateType: "principal",
        aggregateId: id,
        payload: { schema_version: SCHEMA_VERSION, owner_principal_id: actor.principalId },
        requestId: ctx.requestId,
        createdAt,
      }),
      journal(ctx, "agent.created", { type: "principal", id }, "success", null),
    ]);
  } catch (error) {
    if (error instanceof ConstraintViolation && error.constraint === "unique") {
      return fail(ErrorType.Conflict, "Username is taken");
    }
    throw error;
  }

  return ok({ principalId: id, username: name.username });
}

export interface IssueTokenInput {
  principalId: string;
  name: string;
  scopes?: readonly string[];
  expiresAt?: string | null;
}

export async function issueToken(
  ctx: AccountContext,
  input: IssueTokenInput,
): Promise<Result<{ id: OratorId; token: string; scopes: Scope[]; expiresAt: string | null }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const subject = await ctx.ports.principals.findById(input.principalId);
  if (subject === null) return fail(ErrorType.NotFound, "Principal not found");

  // For itself, or for an agent it owns — never for anyone else.
  const isSelf = subject.id === actor.principalId;
  if (!isSelf) {
    if (subject.ownerPrincipalId === undefined) {
      return fail(ErrorType.Forbidden, "Not permitted", DENIAL_DETAIL["not-owner"]);
    }
    const decision = canManageAgent(actor, subject.ownerPrincipalId);
    if (!decision.allowed) {
      return fail(denialToError(decision.reason), "Not permitted", DENIAL_DETAIL[decision.reason]);
    }
  }

  const requested = input.scopes ?? (subject.kind === "agent" ? AGENT_PRESET : DEFAULT_SCOPES);
  const parsed = parseScopes([...requested]);
  if ("invalid" in parsed) {
    return fail(ErrorType.ValidationFailed, "Unknown scope", parsed.invalid.join(", "), {
      invalid_scopes: parsed.invalid,
    });
  }

  // A token cannot grant more than its issuer holds; otherwise scope limits are advisory.
  const escalation = parsed.scopes.filter((scope) => !actor.scopes.includes(scope));
  if (escalation.length > 0) {
    return fail(
      ErrorType.Forbidden,
      "Cannot grant scopes you do not hold",
      escalation.join(", "),
      { escalated_scopes: escalation },
    );
  }
  if (parsed.scopes.some(isAdminScope) && actor.platformRole !== "admin") {
    return fail(ErrorType.Forbidden, "Administrative scopes require the admin role");
  }

  const id = ctx.ports.ids.next();
  const createdAt = ctx.ports.clock.now().toISOString();
  const generated = await generateToken();

  await ctx.ports.db.commit([
    ctx.ports.tokens.insert({
      id,
      principalId: subject.id,
      name: input.name,
      tokenHash: generated.tokenHash,
      prefix: generated.prefix,
      scopes: parsed.scopes,
      expiresAt: input.expiresAt ?? null,
      createdAt,
    }),
    journal(ctx, "token.issued", { type: "token", id }, "success", `scopes=${parsed.scopes.join(",")}`),
  ]);

  // The only time the token itself exists outside the caller's response.
  return ok({ id, token: generated.token, scopes: parsed.scopes, expiresAt: input.expiresAt ?? null });
}

/**
 * Revokes a token, one's own or one belonging to an agent one owns (SPEC §42.2, §7.2).
 *
 * The owned-agent half is not an extension. `issueToken` above mints tokens for an agent
 * its caller owns, and this only ever looked at the caller's own principal — so a human
 * could give their agent a credential and then had no way to take it back. An accountability
 * chain (§7.2) that grants without revoking is not one.
 *
 * "Not found" answers a token that exists and is somebody else's. A caller who may not
 * revoke it has no business learning it exists, and 403 would say so.
 */
export async function revokeToken(ctx: AccountContext, tokenId: string): Promise<Result<true>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const token = await ctx.ports.tokens.findById(tokenId);
  if (token === null) return fail(ErrorType.NotFound, "Token not found");

  if (token.principalId !== actor.principalId) {
    const subject = await ctx.ports.principals.findById(token.principalId);
    if (subject === null || subject.ownerPrincipalId === undefined) {
      return fail(ErrorType.NotFound, "Token not found");
    }
    const decision = canManageAgent(actor, subject.ownerPrincipalId);
    if (!decision.allowed) return fail(ErrorType.NotFound, "Token not found");
  }

  // Already revoked is a success, not a conflict: the caller wanted it gone and it is.
  // A second audit row for a second click would record an action that did not happen.
  if (token.revokedAt !== null) return ok(true);

  const at = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([
    ctx.ports.tokens.revoke(tokenId, at),
    journal(ctx, "token.revoked", { type: "token", id: tokenId }, "success", null),
  ]);
  return ok(true);
}

/**
 * Resolves a bearer token to an actor (SPEC §42.2).
 *
 * `last_used_at` is deliberately not written here: doing so would turn every authenticated
 * read into a database write, on the hottest path in the system (§42.2).
 */
/**
 * Resolves a bearer token to an actor.
 *
 * Takes the three ports it reads rather than the whole set, so that a surface holding only
 * a slice of `Ports` — the web app, which must not be able to publish (§28) — can still
 * authenticate a caller.
 */
export async function authenticate(
  ports: Pick<Ports, "tokens" | "principals" | "clock">,
  token: string,
): Promise<Result<{ actor: Actor; tokenId: OratorId }>> {
  const record = await ports.tokens.findByHash(await sha256Hex(token));
  if (record === null) return fail(ErrorType.Unauthenticated, "Invalid token");
  if (record.revokedAt !== null) return fail(ErrorType.Unauthenticated, "Token revoked");
  if (isExpired(record.expiresAt, ports.clock.now())) {
    return fail(ErrorType.Unauthenticated, "Token expired");
  }

  const principal = await ports.principals.findById(record.principalId);
  if (principal === null) return fail(ErrorType.Unauthenticated, "Invalid token");
  if (principal.status !== "active") {
    return fail(ErrorType.Forbidden, "Principal is not active", DENIAL_DETAIL.suspended);
  }

  const actor: Actor = {
    principalId: principal.id,
    kind: principal.kind,
    platformRole: principal.platformRole,
    scopes: record.scopes as Scope[],
    status: principal.status,
    // A human has no trust ladder (§60.2 is about agents), and level 1 is the ordinary
    // state an honest account sits at — the level the published limits are written for.
    trustLevel: principal.trustLevel ?? 1,
    systemAccount: principal.systemAccount,
    ...(principal.ownerPrincipalId === undefined ? {} : { ownerPrincipalId: principal.ownerPrincipalId }),
  };
  return ok({ actor, tokenId: record.id });
}

/** How long a registration challenge stays valid. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Issues a challenge for key registration (SPEC §8.2).
 *
 * The nonce is an ordinary identifier, and identifiers embed their creation time (§12.2),
 * so freshness is checked by reading the nonce rather than by storing it. Skipping the
 * table is safe here because replay achieves nothing: the challenge is bound to a specific
 * principal, and re-proving possession of a key that is already registered changes nothing.
 */
export function createKeyChallenge(ctx: AccountContext, agentPrincipalId: string): Result<{
  nonce: string;
  message: string;
  expires_at: string;
}> {
  const nonce = ctx.ports.ids.next();
  return ok({
    nonce,
    message: keyRegistrationInput(nonce, agentPrincipalId),
    // A deadline rather than a duration: the caller has a clock and no idea how long the
    // response spent in transit, so "in five minutes" is the less useful of the two.
    expires_at: new Date(ctx.ports.clock.now().getTime() + CHALLENGE_TTL_MS).toISOString(),
  });
}

export interface RegisterKeyInput {
  agentPrincipalId: string;
  publicKey: string;
  nonce: string;
  signature: string;
  label?: string | null;
}

export async function registerAgentKey(
  ctx: AccountContext,
  input: RegisterKeyInput,
): Promise<Result<{ id: OratorId; fingerprint: string }>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const agent = await ctx.ports.principals.findById(input.agentPrincipalId);
  if (agent === null || agent.kind !== "agent" || agent.ownerPrincipalId === undefined) {
    return fail(ErrorType.NotFound, "Agent not found");
  }

  const decision = canManageAgent(actor, agent.ownerPrincipalId);
  if (!decision.allowed) {
    await ctx.ports.db.commit([
      journal(ctx, "key.register", { type: "principal", id: agent.id }, "denied", decision.reason),
    ]);
    return fail(denialToError(decision.reason), "Not permitted", DENIAL_DETAIL[decision.reason]);
  }

  const issuedAt = idTimestampSafe(input.nonce);
  if (issuedAt === null) return fail(ErrorType.ValidationFailed, "Malformed challenge nonce");
  const age = ctx.ports.clock.now().getTime() - issuedAt;
  if (age < 0 || age > CHALLENGE_TTL_MS) {
    return fail(ErrorType.ValidationFailed, "Challenge expired", "Request a new challenge and sign it.");
  }

  const proven = await verifySignature(
    input.publicKey,
    input.signature,
    keyRegistrationInput(input.nonce, input.agentPrincipalId),
  );
  if (!proven) {
    await ctx.ports.db.commit([
      journal(ctx, "key.register", { type: "principal", id: agent.id }, "denied", "bad-signature"),
    ]);
    return fail(
      ErrorType.ValidationFailed,
      "Signature does not verify",
      "The signature must cover the exact challenge message, using the private key for the submitted public key.",
    );
  }

  const print = await fingerprint(input.publicKey);
  const existing = await ctx.ports.keys.findByFingerprint(print);
  if (existing !== null) {
    return existing.agentPrincipalId === agent.id
      ? ok({ id: existing.id, fingerprint: print })
      : fail(ErrorType.Conflict, "This key is already registered to another agent");
  }

  const id = ctx.ports.ids.next();
  const createdAt = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([
    ctx.ports.keys.insert({
      id,
      agentPrincipalId: agent.id,
      publicKey: input.publicKey,
      fingerprint: print,
      label: input.label ?? null,
      createdAt,
    }),
    journal(ctx, "key.registered", { type: "agent_key", id }, "success", print),
  ]);
  return ok({ id, fingerprint: print });
}

export async function revokeAgentKey(
  ctx: AccountContext,
  keyId: string,
  reason?: string | null,
): Promise<Result<true>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const key = await ctx.ports.keys.findById(keyId);
  if (key === null) return fail(ErrorType.NotFound, "Key not found");

  const agent = await ctx.ports.principals.findById(key.agentPrincipalId);
  if (agent?.ownerPrincipalId === undefined) return fail(ErrorType.NotFound, "Key not found");

  const decision = canManageAgent(actor, agent.ownerPrincipalId);
  if (!decision.allowed) {
    return fail(denialToError(decision.reason), "Not permitted", DENIAL_DETAIL[decision.reason]);
  }

  const at = ctx.ports.clock.now().toISOString();
  await ctx.ports.db.commit([
    ctx.ports.keys.revoke(keyId, at, reason ?? null),
    journal(ctx, "key.revoked", { type: "agent_key", id: keyId }, "success", reason ?? null),
  ]);
  // Signatures made before `at` stay verifiable; revocation is a boundary, not an eraser.
  return ok(true);
}

/** Reads the timestamp out of an identifier, tolerating anything that is not one. */
function idTimestampSafe(value: string): number | null {
  try {
    return idTimestamp(value as OratorId);
  } catch {
    return null;
  }
}

/**
 * Updates a principal's own profile (SPEC §44.2 merge semantics).
 *
 * The username is not among the fields. It is protected against confusables (§7.3), it
 * appears in every byline and citation, and it is not released for twelve months after an
 * account closes (§23.5) — a name that carries reputation is not a mutable display field.
 * Changing one, if it is ever allowed, is its own operation with its own rules.
 */
export async function updateProfile(
  ctx: AccountContext,
  principalId: string,
  input: { displayName?: string | null; bio?: string | null },
): Promise<Result<PrincipalRecord>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const subject = await ctx.ports.principals.findById(principalId);
  if (subject === null || subject.status === "deleted") {
    return fail(ErrorType.NotFound, "Principal not found");
  }

  // Self, or the human accountable for this agent. A sibling agent under the same owner
  // may not, for the same reason it may not touch a sibling's articles (§43.2).
  const isSelf = subject.id === actor.principalId;
  const isOwner = actor.kind === "human" && subject.ownerPrincipalId === actor.principalId;
  if (!isSelf && !isOwner) {
    return fail(ErrorType.Forbidden, "Not permitted", "A profile is edited by its principal or that principal's owner.");
  }
  if (!hasScope(actor.scopes, "profile:write")) {
    return fail(ErrorType.InsufficientScope, "Not permitted", "The token does not carry profile:write.");
  }

  const now = ctx.ports.clock.now().toISOString();
  const fields = {
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.bio === undefined ? {} : { bio: input.bio }),
  };
  if (Object.keys(fields).length === 0) return ok(subject);

  await ctx.ports.db.commit([ctx.ports.principals.updateProfile(subject.id, fields, now)]);
  return ok({ ...subject, ...fields });
}

/**
 * Scope presets and helpers (SPEC §43.1).
 *
 * The list of scopes itself lives in `protocol`: it is a wire contract, appearing in token
 * requests, in OpenAPI and in the MCP tool definitions. What lives here is what the domain
 * does with it — which bundles are handed out, and how a request is checked.
 */
export { isAdminScope, isScope, SCOPES, type Scope } from "@orator/protocol";
import { isScope, type Scope } from "@orator/protocol";

/**
 * What a token gets when the caller asks for nothing. Read-only: a token that could
 * publish because its scopes were left unspecified is the kind of default that is only
 * noticed after it has been used (§43.1).
 */
export const DEFAULT_SCOPES: readonly Scope[] = ["articles:read", "comments:read"];

/** Scopes an agent needs to take part in the loop SPEC §84 describes. */
export const AGENT_PRESET: readonly Scope[] = [
  "articles:read",
  "articles:write",
  "articles:publish",
  // Tombstoning its own work, yes. Erasing the bytes takes more than a scope: §23.3
  // requires a human actor, because destroying evidence is an accountable act.
  "articles:delete",
  "comments:read",
  "comments:write",
  "edges:write",
  "follows:write",
  "events:read",
  "media:write",
  "profile:write",
];

/**
 * What the first token for a human account carries.
 *
 * It has to be the full set a human may hold, because a token cannot grant scopes its
 * issuer lacks: a narrower bootstrap token could never mint a publishing token for an
 * agent, and the account would be permanently unable to do the thing it exists for.
 * Every subsequent token is derived from this one and is narrower.
 */
export const OWNER_PRESET: readonly Scope[] = [
  ...AGENT_PRESET,
  "agents:read",
  "agents:manage",
];

export function parseScopes(input: readonly string[]): { scopes: Scope[] } | { invalid: string[] } {
  const invalid = input.filter((value) => !isScope(value));
  if (invalid.length > 0) return { invalid };
  return { scopes: [...new Set(input as Scope[])] };
}

export const hasScope = (granted: readonly Scope[], required: Scope): boolean =>
  granted.includes(required);


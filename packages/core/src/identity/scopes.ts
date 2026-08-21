/**
 * Token scopes (SPEC §43.1).
 *
 * `articles:write` and `articles:publish` are separate on purpose: it lets an owner hand
 * an assistant the ability to prepare drafts without the ability to publish them, which
 * is the shape of the main product workflow (§4.3).
 */
export const SCOPES = [
  "articles:read",
  "articles:write",
  "articles:publish",
  "comments:read",
  "comments:write",
  "media:write",
  "edges:write",
  "follows:write",
  "agents:read",
  "agents:manage",
  "events:read",
  "admin:moderate",
  "admin:manage",
] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);
export const isScope = (value: string): value is Scope => SCOPE_SET.has(value);

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
  "comments:read",
  "comments:write",
  "edges:write",
  "follows:write",
  "events:read",
  "media:write",
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

/** Admin scopes are never granted implicitly; they are always requested explicitly. */
export const isAdminScope = (scope: Scope): boolean => scope.startsWith("admin:");

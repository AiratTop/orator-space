/**
 * Token scopes (SPEC §43.1).
 *
 * In `protocol` rather than in the domain because a scope is a wire contract: it appears in
 * a token issuance request, in a token listing, in the OpenAPI document and in the MCP tool
 * definitions. The domain's presets and authorisation rules build on this list; the list
 * itself is what a client sees.
 *
 * `articles:write` and `articles:publish` are separate on purpose: it lets an owner hand an
 * assistant the ability to prepare drafts without the ability to publish them, which is the
 * shape of the main product workflow (§4.3).
 */
export const SCOPES = [
  "articles:read",
  "articles:write",
  "articles:publish",
  "articles:delete",
  "comments:read",
  "comments:write",
  "media:write",
  "edges:write",
  "follows:write",
  "agents:read",
  "agents:manage",
  "events:read",
  "profile:write",
  "admin:moderate",
  "admin:manage",
] as const;

export type Scope = (typeof SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);
export const isScope = (value: string): value is Scope => SCOPE_SET.has(value);

/** Admin scopes are never granted implicitly; they are always requested explicitly. */
export const isAdminScope = (scope: Scope): boolean => scope.startsWith("admin:");

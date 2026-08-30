/**
 * @orator/protocol — the single source of truth for wire contracts (SPEC §53).
 * OpenAPI, SDK types and MCP tool schemas are generated from here; none are hand-written.
 *
 * This package MUST NOT depend on anything else in the workspace (SPEC §73.1).
 */
export const PROTOCOL_VERSION = "v1" as const;

export * from "./version.js";
export * from "./versioned.js";
export * from "./ids.js";
export * from "./errors.js";
export * from "./cursor.js";
export * from "./negotiate.js";
export * from "./scopes.js";
export * as schemas from "./schemas.js";
export * from "./api.js";
export * from "./mcp.js";

/**
 * @orator/protocol — the single source of truth for wire contracts (SPEC §53).
 * OpenAPI, SDK types and MCP tool schemas are generated from here; none are hand-written.
 *
 * This package MUST NOT depend on anything else in the workspace (SPEC §73.1).
 */
export const PROTOCOL_VERSION = "v1" as const;

/** SPEC §46.4 — every JSON blob persisted or transmitted carries its schema version. */
export const SCHEMA_VERSION = 1 as const;

export * from "./ids.js";
export * from "./errors.js";
export * from "./cursor.js";
export * from "./negotiate.js";

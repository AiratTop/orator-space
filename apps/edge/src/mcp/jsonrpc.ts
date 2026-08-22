/**
 * JSON-RPC 2.0, the layer MCP speaks (SPEC §47).
 *
 * Separate from the MCP semantics above it because the two fail differently and a client
 * has to tell them apart: a malformed envelope is a protocol error carried in `error`,
 * while a tool that refuses is a successful call whose result says so. Collapsing them is
 * the standard way an MCP server becomes hard to drive from a model — every failure looks
 * like the transport broke.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification;

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** The codes JSON-RPC reserves. Anything above -32000 would be ours; none is needed yet. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export const failure = (
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export const success = (id: string | number, result: unknown): JsonRpcSuccess => ({
  jsonrpc: "2.0",
  id,
  result,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isRequest = (message: JsonRpcMessage): message is JsonRpcRequest =>
  "id" in message && message.id !== undefined && message.id !== null;

/** Validates the envelope only. What `params` must contain is the method's business. */
export function parseMessage(value: unknown): JsonRpcMessage | null {
  if (!isObject(value)) return null;
  if (value.jsonrpc !== "2.0") return null;
  if (typeof value.method !== "string") return null;
  if (value.params !== undefined && !isObject(value.params)) return null;

  const id = value.id;
  if (id === undefined || id === null) {
    return { jsonrpc: "2.0", method: value.method, ...(value.params ? { params: value.params } : {}) };
  }
  if (typeof id !== "string" && typeof id !== "number") return null;
  return {
    jsonrpc: "2.0",
    id,
    method: value.method,
    ...(value.params ? { params: value.params } : {}),
  };
}

import { z } from "zod";
import {
  ErrorType,
  MCP_INSTRUCTIONS,
  OPERATIONS,
  PROTOCOL_VERSION,
  TOOLS,
  problem,
  toolByName,
} from "@orator/protocol";
import type { ServiceError } from "@orator/core";
import { resolveTool, type ToolContext } from "./tools.js";
import { frameUntrusted, sourcesOf } from "./untrusted.js";
import {
  ErrorCode,
  failure,
  isRequest,
  parseMessage,
  success,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "./jsonrpc.js";

/**
 * The MCP server (SPEC §47), speaking Streamable HTTP without sessions.
 *
 * Everything here is one request in, one response out. There is no session id, no
 * server-initiated stream, and nothing kept between calls — which is what lets MCP live in
 * the same Worker as the REST API rather than in a Durable Object holding a connection
 * open. The transport permits it: a server that offers no standalone stream answers `GET`
 * with 405, and clients are required to accept that.
 *
 * What it costs is the features that need a live channel — server-initiated sampling,
 * progress notifications, subscriptions. None of them appears in §47.1, and buying them
 * now would mean an object per connected agent whose idle cost is still unmeasured
 * (ADR 0001).
 */

/** Newest first; negotiation picks the client's choice when we know it. */
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const PREFERRED_VERSION = SUPPORTED_VERSIONS[0];

const SERVER_INFO = {
  name: "orator-space",
  title: "Orator.Space",
  version: PROTOCOL_VERSION,
  websiteUrl: "https://orator.space",
} as const;

/**
 * The JSON Schema a host shows a model.
 *
 * Generated from the same zod schemas the REST API validates against, so a tool cannot
 * advertise a shape the service will reject. `io: "input"` matters: it renders what a
 * caller may send, which is a different document from what comes back — defaults are
 * optional going in and present coming out.
 */
const inputSchemaOf = (schema: z.ZodTypeAny): Record<string, unknown> => {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete json.$schema;
  // MCP requires an object schema; a tool taking nothing still says so explicitly.
  return { type: "object", properties: {}, ...json };
};

const describeTool = (tool: (typeof TOOLS)[number]) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: inputSchemaOf(tool.inputSchema),
  annotations: { title: tool.title, ...tool.annotations },
});

/**
 * A refusal by a tool is a successful call whose result says no (SPEC §45 over §47).
 *
 * MCP separates protocol errors from tool errors for a reason that matters more for
 * agents than for people: a model needs to distinguish "the call did not happen" from
 * "the call happened and the answer is no". The problem document goes through unchanged,
 * so an agent that knows the REST error catalogue already knows this one.
 */
function toolFailure(error: ServiceError, requestId: string) {
  const document = problem(error.type, error.title, {
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    request_id: requestId,
    ...(error.extra ?? {}),
  });
  return {
    isError: true,
    structuredContent: document,
    content: [
      {
        type: "text" as const,
        text: `The call was refused: ${error.title}${error.detail === undefined ? "" : `\n${error.detail}`}\n\nerror type: ${document.type}\nstatus: ${String(document.status)}`,
      },
    ],
  };
}

export interface McpRequestContext extends ToolContext {
  requestId: string;
  /** Null when no usable bearer token was presented (SPEC §42.3). */
  authenticated: boolean;
}

/** Handles one JSON-RPC message. Returns null for a notification, which has no reply. */
export async function handleMessage(
  message: JsonRpcMessage,
  mcp: McpRequestContext,
): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    // `notifications/initialized` and friends. Acknowledged by saying nothing, which is
    // what JSON-RPC means by a notification.
    return null;
  }

  const { id, method, params = {} } = message;

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
      const version =
        asked !== null && (SUPPORTED_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : PREFERRED_VERSION;
      return success(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: MCP_INSTRUCTIONS,
      });
    }

    case "ping":
      return success(id, {});

    case "tools/list":
      // No pagination: the whole catalogue is two dozen entries and a cursor would be a
      // second thing to get right for no reader's benefit.
      return success(id, { tools: TOOLS.map(describeTool) });

    case "tools/call":
      return await callTool(id, params, mcp);

    default:
      return failure(id, ErrorCode.MethodNotFound, `Unknown method: ${method}`);
  }
}

async function callTool(
  id: string | number,
  params: Record<string, unknown>,
  mcp: McpRequestContext,
): Promise<JsonRpcResponse> {
  const name = typeof params.name === "string" ? params.name : null;
  if (name === null) return failure(id, ErrorCode.InvalidParams, "tools/call needs a tool name");

  const resolved = resolveTool(name);
  if (resolved === null) return failure(id, ErrorCode.InvalidParams, `Unknown tool: ${name}`);

  const rawArgs = params.arguments;
  const args =
    typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  /**
   * Validated here, against the schema the host was shown.
   *
   * A model producing arguments from a description gets them wrong in ways a person does
   * not — a string where a number belongs, a field invented from the prose. Catching that
   * against the advertised schema turns it into a message the model can act on, instead of
   * a service failure that describes an internal expectation.
   */
  const parsed = resolved.tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return success(
      id,
      toolFailure(
        {
          type: ErrorType.ValidationFailed,
          title: `Arguments for ${name} are not valid`,
          detail: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
            .join("; "),
        },
        mcp.requestId,
      ),
    );
  }

  /**
   * Authentication is checked from the catalogue rather than restated here.
   *
   * Every tool names the REST operation it exercises, and that operation already says
   * whether a token is required and which scopes it needs (§43.4). Re-deciding it in this
   * file is how MCP would come to disagree with REST about who may do what.
   */
  const needsAuth = requiresAuth(name);
  if (needsAuth && !mcp.authenticated) {
    return success(
      id,
      toolFailure(
        {
          type: ErrorType.Unauthenticated,
          title: "This tool needs a token",
          detail:
            "Create a token in your Orator settings and set it as an Authorization: Bearer " +
            "header in this server's configuration (§42.3).",
        },
        mcp.requestId,
      ),
    );
  }

  const started = Date.now();
  const result = await resolved.run(mcp, parsed.data as Record<string, unknown>);

  /*
   * §66.2, §83 — MCP requests are counted separately from REST because §66.5 makes them a
   * separate audience and §83 asks for the split by name. The tool is the dimension: "which
   * tools do agents actually use" is the question that decides what §47.1 should grow.
   */
  mcp.ctx.ports.metrics.write({
    name: "mcp.tool",
    audience: mcp.ctx.audience,
    subject: resolved.tool.name,
    detail: result.ok ? "ok" : result.error.type,
    durationMs: Date.now() - started,
  });

  if (!result.ok) return success(id, toolFailure(result.error, mcp.requestId));

  const payload = result.value;
  const text = resolved.tool.untrusted
    ? frameUntrusted(payload, sourcesOf(payload))
    : JSON.stringify(payload, null, 2);

  return success(id, {
    content: [{ type: "text", text }],
    structuredContent: payload as Record<string, unknown>,
  });
}

const AUTH_BY_TOOL = new Map(
  TOOLS.map((tool) => [
    tool.name,
    OPERATIONS.find((operation) => operation.id === tool.operationId)?.auth ?? "required",
  ]),
);

/** Whether the operation behind this tool demands a token. Read, never restated. */
export const requiresAuth = (name: string): boolean =>
  toolByName(name) !== undefined && AUTH_BY_TOOL.get(name) === "required";

export { parseMessage, ErrorCode, failure };
export type { JsonRpcMessage, JsonRpcResponse };

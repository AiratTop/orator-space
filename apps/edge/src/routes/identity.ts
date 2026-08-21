import { Hono } from "hono";
import { z } from "zod";
import {
  createKeyChallenge,
  issueToken,
  registerAgent,
  registerAgentKey,
  registerHuman,
  revokeAgentKey,
  revokeToken,
  SCOPES,
  type PrincipalRecord,
  type RequestContext,
} from "@orator/core";
import { ErrorType } from "@orator/protocol";
import { problemResponse, respond } from "../http.js";
import type { Env } from "../index.js";

type Vars = { requestId: string; ctx: RequestContext };
type Ctx = Parameters<typeof problemResponse>[0];

/**
 * REST adapter for identity (SPEC §44.1).
 *
 * Every handler validates, calls one application service, and renders the result. No
 * business rule and no storage write lives here: REST, MCP and the web app must reach the
 * same verdict for the same question, and three copies of a rule diverge (§28.1, §43.4).
 */
export const identityRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function parse<T>(c: Ctx, schema: z.ZodType<T>, body: unknown) {
  const result = schema.safeParse(body);
  if (result.success) return { data: result.data } as const;
  return {
    response: problemResponse(
      c,
      {
        type: ErrorType.ValidationFailed,
        title: "Request body is not valid",
        // Field-level detail, because an error an agent cannot act on programmatically
        // is a defect in the API rather than a message (SPEC §45.1).
        detail: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
        extra: { errors: result.error.issues.map((i) => ({ field: i.path.join("."), code: i.code })) },
      },
      new URL(c.req.url).pathname,
    ),
  } as const;
}

const usernameField = z.string().min(1).max(64);

const humanSchema = z.object({
  username: usernameField,
  display_name: z.string().max(120).nullish(),
  email: z.string().email().nullish(),
});

identityRoutes.post("/v1/humans", async (c) => {
  const parsed = parse(c, humanSchema, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;

  const result = await registerHuman(c.get("ctx"), {
    username: parsed.data.username,
    displayName: parsed.data.display_name ?? null,
    email: parsed.data.email ?? null,
  });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  return respond(
    c,
    {
      ok: true,
      value: {
        id: result.value.principalId,
        username: result.value.username,
        // Shown once. Without it the account has no way to authenticate and cannot issue
        // itself a token, since issuing requires authentication.
        token: result.value.token,
        scopes: result.value.scopes,
      },
    },
    201,
  );
});

const agentSchema = z.object({
  username: usernameField,
  display_name: z.string().max(120).nullish(),
  model: z.string().max(120).nullish(),
  provider: z.string().max(120).nullish(),
});

identityRoutes.post("/v1/agents", async (c) => {
  const parsed = parse(c, agentSchema, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;
  return respond(
    c,
    await registerAgent(c.get("ctx"), {
      username: parsed.data.username,
      displayName: parsed.data.display_name ?? null,
      model: parsed.data.model ?? null,
      provider: parsed.data.provider ?? null,
    }),
    201,
  );
});

/** Only what is safe for anyone to read. */
function publicView(record: PrincipalRecord) {
  return {
    id: record.id,
    kind: record.kind,
    username: record.username,
    display_name: record.displayName,
    bio: record.bio,
    created_at: record.createdAt,
    ...(record.ownerPrincipalId === undefined
      ? {}
      : {
          // Owner is public because accountability is the entire point of §7.2; model and
          // provider are published so a reader can weigh the source (§4.2).
          owner_principal_id: record.ownerPrincipalId,
          model: record.model ?? null,
          provider: record.provider ?? null,
          trust_level: record.trustLevel ?? 0,
        }),
  };
}

const notFound = (c: Ctx) =>
  problemResponse(c, { type: ErrorType.NotFound, title: "Principal not found" }, new URL(c.req.url).pathname);

identityRoutes.get("/v1/principals/:id", async (c) => {
  const record = await c.get("ctx").ports.principals.findById(c.req.param("id"));
  if (record === null || record.status === "deleted") return notFound(c);
  return respond(c, { ok: true, value: publicView(record) });
});

identityRoutes.get("/v1/principals/by-username/:username", async (c) => {
  const record = await c.get("ctx").ports.principals.findByUsername(c.req.param("username").toLowerCase());
  if (record === null || record.status === "deleted") return notFound(c);
  return respond(c, { ok: true, value: publicView(record) });
});

const tokenSchema = z.object({
  principal_id: z.string(),
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(SCOPES)).optional(),
  expires_at: z.string().datetime().nullish(),
});

identityRoutes.post("/v1/tokens", async (c) => {
  const parsed = parse(c, tokenSchema, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;

  const result = await issueToken(c.get("ctx"), {
    principalId: parsed.data.principal_id,
    name: parsed.data.name,
    ...(parsed.data.scopes === undefined ? {} : { scopes: parsed.data.scopes }),
    expiresAt: parsed.data.expires_at ?? null,
  });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  return respond(
    c,
    {
      ok: true,
      value: {
        id: result.value.id,
        // Present in exactly one response and never retrievable again (SPEC §42.2).
        token: result.value.token,
        scopes: result.value.scopes,
        expires_at: result.value.expiresAt,
      },
    },
    201,
  );
});

identityRoutes.get("/v1/tokens", async (c) => {
  const ctx = c.get("ctx");
  if (ctx.actor === null) {
    return problemResponse(c, { type: ErrorType.Unauthenticated, title: "Authentication required" });
  }
  const tokens = await ctx.ports.tokens.listFor(ctx.actor.principalId);
  return respond(c, {
    ok: true,
    value: tokens.map((token) => ({
      id: token.id,
      name: token.name,
      prefix: token.prefix,
      scopes: token.scopes,
      created_at: token.createdAt,
      last_used_at: token.lastUsedAt,
      expires_at: token.expiresAt,
      revoked_at: token.revokedAt,
    })),
  });
});

identityRoutes.delete("/v1/tokens/:id", async (c) =>
  respond(c, await revokeToken(c.get("ctx"), c.req.param("id"))),
);

identityRoutes.post("/v1/agents/:id/keys/challenge", async (c) =>
  respond(c, createKeyChallenge(c.get("ctx"), c.req.param("id")), 201),
);

const keySchema = z.object({
  public_key: z.string().min(40).max(100),
  nonce: z.string().length(26),
  signature: z.string().min(80).max(100),
  label: z.string().max(80).nullish(),
});

identityRoutes.post("/v1/agents/:id/keys", async (c) => {
  const parsed = parse(c, keySchema, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;
  return respond(
    c,
    await registerAgentKey(c.get("ctx"), {
      agentPrincipalId: c.req.param("id"),
      publicKey: parsed.data.public_key,
      nonce: parsed.data.nonce,
      signature: parsed.data.signature,
      label: parsed.data.label ?? null,
    }),
    201,
  );
});

identityRoutes.get("/v1/agents/:id/keys", async (c) => {
  const keys = await c.get("ctx").ports.keys.listFor(c.req.param("id"));
  return respond(c, {
    ok: true,
    // Revoked keys stay listed: a verifier still needs the material to check signatures
    // made before revocation, which revocation does not invalidate (SPEC §8.2).
    value: keys.map((key) => ({
      id: key.id,
      public_key: key.publicKey,
      fingerprint: key.fingerprint,
      label: key.label,
      status: key.status,
      created_at: key.createdAt,
      revoked_at: key.revokedAt,
    })),
  });
});

identityRoutes.delete("/v1/agents/:agentId/keys/:keyId", async (c) =>
  respond(c, await revokeAgentKey(c.get("ctx"), c.req.param("keyId"), c.req.query("reason") ?? null)),
);

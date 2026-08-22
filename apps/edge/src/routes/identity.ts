import { Hono } from "hono";
import {
  createKeyChallenge,
  issueToken,
  registerAgent,
  registerAgentKey,
  registerHuman,
  revokeAgentKey,
  revokeToken,
  updateProfile,
  withIdempotency,
  type RequestContext,
} from "@orator/core";
import { ErrorType, schemas } from "@orator/protocol";
import { parse, problemResponse, requireIdempotencyKey, respond } from "../http.js";
import { principalView } from "../views.js";
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


identityRoutes.post("/v1/humans", async (c) => {
  const parsed = parse(c, schemas.registerHumanRequest, await c.req.json().catch(() => null));
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

identityRoutes.post("/v1/agents", async (c) => {
  const parsed = parse(c, schemas.createAgentRequest, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await registerAgent(ctx, {
    username: parsed.data.username,
    displayName: parsed.data.display_name ?? null,
    model: parsed.data.model ?? null,
    provider: parsed.data.provider ?? null,
  });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  return respond(
    c,
    {
      ok: true,
      value: {
        principal_id: result.value.principalId,
        username: result.value.username,
        // The creating human. §7.2 makes this the point of an agent existing, so it is
        // returned rather than left for a second call to discover.
        owner_principal_id: ctx.actor?.principalId ?? null,
      },
    },
    201,
  );
});

const notFound = (c: Ctx) =>
  problemResponse(c, { type: ErrorType.NotFound, title: "Principal not found" }, new URL(c.req.url).pathname);

identityRoutes.get("/v1/principals/:id", async (c) => {
  const record = await c.get("ctx").ports.principals.findById(c.req.param("id"));
  if (record === null || record.status === "deleted") return notFound(c);
  return respond(c, { ok: true, value: principalView(record) });
});

/**
 * SPEC §59.2 — the allowance, to the principal it belongs to or their owner.
 *
 * Not public. A quota reading is an operational fact about somebody else's account: how
 * much they have published today, how close they are to a limit. Reading it costs no
 * scope beyond a token, because an agent refused a scope it does not need cannot plan its
 * work either — and the only thing it discloses is its own state.
 */
identityRoutes.get("/v1/principals/:id/quota", async (c) => {
  const ctx = c.get("ctx");
  const actor = ctx.actor;
  if (actor === null) {
    return problemResponse(c, { type: ErrorType.Unauthenticated, title: "Authentication required" });
  }

  const record = await ctx.ports.principals.findById(c.req.param("id"));
  if (record === null || record.status === "deleted") return notFound(c);

  const own = record.id === actor.principalId;
  const owned = record.ownerPrincipalId !== undefined && record.ownerPrincipalId === actor.principalId;
  if (!own && !owned && actor.platformRole === "user") {
    // 404 rather than 403: whether a principal exists is public, but whose agent it is and
    // what it has spent are not, and a distinguishable refusal is an oracle for both.
    return notFound(c);
  }

  const trustLevel = record.trustLevel ?? 1;
  const quotas = await ctx.ports.quota.peek(record.id, trustLevel);
  return respond(c, {
    ok: true,
    value: {
      principal_id: record.id,
      trust_level: trustLevel,
      quotas: quotas.map((quota) => ({
        action: quota.action,
        limit: quota.limit,
        remaining: quota.remaining,
        window: quota.window,
        reset_at: quota.resetAt,
      })),
    },
  });
});

identityRoutes.get("/v1/principals/by-username/:username", async (c) => {
  const record = await c.get("ctx").ports.principals.findByUsername(c.req.param("username").toLowerCase());
  if (record === null || record.status === "deleted") return notFound(c);
  return respond(c, { ok: true, value: principalView(record) });
});

/**
 * SPEC §34.1 — a key is required here, unlike the other identity endpoints.
 *
 * Everything else in this file is idempotent by nature: a repeated registration collides
 * with a unique username or fingerprint, and a repeated challenge is a fresh nonce that
 * costs nothing. Issuing a token is not. A client that loses the response has a token it
 * can never see again and no way to know it exists, and a retry mints a second one.
 */
identityRoutes.post("/v1/tokens", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, schemas.issueTokenRequest, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await withIdempotency(ctx, idem.key, "POST /v1/tokens", body, () =>
    issueToken(ctx, {
      principalId: parsed.data.principal_id,
      name: parsed.data.name,
      ...(parsed.data.scopes === undefined ? {} : { scopes: parsed.data.scopes }),
      expiresAt: parsed.data.expires_at ?? null,
    }),
  );
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
    value: {
      next_cursor: null,
      items: tokens.map((token) => ({
        id: token.id,
        name: token.name,
        prefix: token.prefix,
        scopes: token.scopes,
        created_at: token.createdAt,
        last_used_at: token.lastUsedAt,
        expires_at: token.expiresAt,
        revoked_at: token.revokedAt,
      })),
    },
  });
});

identityRoutes.delete("/v1/tokens/:id", async (c) =>
  respond(c, await revokeToken(c.get("ctx"), c.req.param("id"))),
);

identityRoutes.post("/v1/agents/:id/keys/challenge", async (c) => {
  const result = createKeyChallenge(c.get("ctx"), c.req.param("id"));
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);
  return respond(c, { ok: true, value: result.value }, 201);
});

identityRoutes.post("/v1/agents/:id/keys", async (c) => {
  const parsed = parse(c, schemas.registerKeyRequest, await c.req.json().catch(() => null));
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
    value: {
      next_cursor: null,
      items: keys.map((key) => ({
        id: key.id,
        public_key: key.publicKey,
        fingerprint: key.fingerprint,
        label: key.label,
        status: key.status,
        created_at: key.createdAt,
        revoked_at: key.revokedAt,
      })),
    },
  });
});

identityRoutes.delete("/v1/agents/:agentId/keys/:keyId", async (c) =>
  respond(c, await revokeAgentKey(c.get("ctx"), c.req.param("keyId"), c.req.query("reason") ?? null)),
);

identityRoutes.patch("/v1/principals/:id", async (c) => {
  const parsed = parse(c, schemas.updatePrincipalRequest, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;

  const result = await updateProfile(c.get("ctx"), c.req.param("id"), {
    ...(parsed.data.display_name === undefined ? {} : { displayName: parsed.data.display_name }),
    ...(parsed.data.bio === undefined ? {} : { bio: parsed.data.bio }),
  });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);
  return respond(c, { ok: true, value: principalView(result.value) });
});

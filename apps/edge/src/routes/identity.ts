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
  type PrincipalRecord,
  type RequestContext,
} from "@orator/core";
import { ErrorType, schemas } from "@orator/protocol";
import { parse, problemResponse, requireIdempotencyKey, respond } from "../http.js";
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

identityRoutes.patch("/v1/principals/:id", async (c) => {
  const parsed = parse(c, schemas.updatePrincipalRequest, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;

  const result = await updateProfile(c.get("ctx"), c.req.param("id"), {
    ...(parsed.data.display_name === undefined ? {} : { displayName: parsed.data.display_name }),
    ...(parsed.data.bio === undefined ? {} : { bio: parsed.data.bio }),
  });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);
  return respond(c, { ok: true, value: publicView(result.value) });
});

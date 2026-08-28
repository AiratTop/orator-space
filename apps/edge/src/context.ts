import {
  createArticleRepo,
  createAuditRepo,
  createD1Database,
  createEventRepo,
  createIdempotencyRepo,
  createIdGen,
  createKeyRepo,
  createOutboxRepo,
  createQueueEventBus,
  createCredentialRepo,
  createMetrics,
  createPrincipalRepo,
  createQuotaGate,
  createSessionRepo,
  createMediaRepo,
  createR2AssetStore,
  createR2ContentStore,
  createR2MediaStore,
  createReadingRepo,
  createSearchIndex,
  createSitemapRepo,
  createSloRepo,
  createSocialRepo,
  createModerationRepo,
  createImageTransform,
  createReadingListRepo,
  createTopicAssignmentRepo,
  createTopicRepo,
  createTokenRepo,
  systemClock,
} from "@orator/adapters-cf";
import {
  authenticate,
  bearerFrom,
  classify,
  type Ports,
  type RequestContext,
  type Surface,
} from "@orator/core";
import type { Env } from "./index.js";

const idGen = createIdGen();

/** Assembles the ports a request may use. The only place adapters are chosen. */
export function portsFor(env: Env): Ports {
  return {
    db: createD1Database(env.DB),
    principals: createPrincipalRepo(env.DB),
    tokens: createTokenRepo(env.DB),
    keys: createKeyRepo(env.DB),
    audit: createAuditRepo(env.DB),
    outbox: createOutboxRepo(env.DB),
    eventBus: createQueueEventBus(env.EVENTS),
    articles: createArticleRepo(env.DB),
    reading: createReadingRepo(env.DB),
    social: createSocialRepo(env.DB),
    search: createSearchIndex(env.DB),
    topics: createTopicRepo(env.DB),
    topicAssignments: createTopicAssignmentRepo(env.DB),
    readingList: createReadingListRepo(env.DB),
    media: createMediaRepo(env.DB),
    mediaStore: createR2MediaStore(env.MEDIA),
    transform: createImageTransform(env.IMAGES),
    moderation: createModerationRepo(env.DB),
    sitemap: createSitemapRepo(env.DB),
    slo: createSloRepo(env.DB),
    assets: createR2AssetStore(env.ASSETS_BUCKET),
    credentials: createCredentialRepo(env.DB),
    sessions: createSessionRepo(env.DB),
    events: createEventRepo(env.DB),
    metrics: createMetrics(env.METRICS),
    quota: createQuotaGate(env.QUOTA),
    idempotency: createIdempotencyRepo(env.DB),
    content: createR2ContentStore(env.CONTENT),
    clock: systemClock,
    ids: idGen,
  };
}

/** SPEC §62 — the address itself is never stored, only a salted digest. */
async function hashIp(ip: string | null, salt: string): Promise<string | null> {
  if (ip === null) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ip));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/**
 * Builds the request context, resolving the bearer token if one is present.
 *
 * An invalid token yields an unauthenticated context rather than an error: whether a
 * given route requires authentication is the service's decision, not the middleware's,
 * so that one rule lives in one place (SPEC §43.4).
 */
export async function contextFor(
  request: Request,
  env: Env,
  requestId: string,
  surface: Surface = "api",
): Promise<RequestContext> {
  const ports = portsFor(env);
  const ipHash = await hashIp(request.headers.get("cf-connecting-ip"), env.ENVIRONMENT);
  const userAgent = request.headers.get("user-agent");
  const accept = request.headers.get("accept");

  const base: RequestContext = {
    ports,
    requestId,
    actor: null,
    tokenId: null,
    ipHash,
    userAgent,
    audience: classify({ surface, actor: null, hasSession: false, userAgent, accept }),
  };

  const token = bearerFrom(request.headers.get("authorization"));
  if (token === null) return base;

  const result = await authenticate(ports, token);
  if (!result.ok) return base;

  // §66.5 — classified once the actor is known, because who is asking is the whole point of
  // the dimension. Nothing here consults the User-Agent for an authenticated caller.
  const actor = result.value.actor;
  return {
    ...base,
    actor,
    tokenId: result.value.tokenId,
    audience: classify({ surface, actor, hasSession: false, userAgent, accept }),
  };
}

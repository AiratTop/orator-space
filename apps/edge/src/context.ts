import {
  createArticleRepo,
  createAuditRepo,
  createD1Database,
  createEmbeddingLedger,
  createVectorIndex,
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
  createWorkersAiEmbedder,
  createRetentionCursorRepo,
  createSloRepo,
  createSocialRepo,
  createModerationRepo,
  createImageTransform,
  createReadingListRepo,
  createTopicAssignmentRepo,
  createTopicRepo,
  createTelegramRepo,
  createTokenRepo,
  systemClock,
} from "@orator/adapters-cf";
import {
  addressPseudonym,
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
    embeddings: createEmbeddingLedger(env.DB),
    topics: createTopicRepo(env.DB),
    topicAssignments: createTopicAssignmentRepo(env.DB),
    readingList: createReadingListRepo(env.DB),
    media: createMediaRepo(env.DB),
    mediaStore: createR2MediaStore(env.MEDIA),
    transform: createImageTransform(env.IMAGES),
    moderation: createModerationRepo(env.DB),
    telegram: createTelegramRepo(env.DB),
    sitemap: createSitemapRepo(env.DB),
    slo: createSloRepo(env.DB),
    retentionCursors: createRetentionCursorRepo(env.DB),
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

/**
 * The two bindings semantic search needs, or nothing (SPEC §38.2, ADR 0012).
 *
 * One function rather than two checks at three call sites, because the interesting property
 * is that they are absent *together*: a model with nowhere to put a vector and a store with
 * nothing to put in it are both "this deployment has no semantic search", and a deployment
 * with one of the two is a configuration mistake rather than a degraded mode. Returning
 * `undefined` for that case makes it behave like the honest absence rather than failing
 * halfway through an article.
 */
export function semanticFor(env: Env) {
  const ai = env.AI;
  const vectors = env.VECTORS;
  if (ai === undefined || vectors === undefined) return undefined;
  return { embedder: createWorkersAiEmbedder(ai), vectors: createVectorIndex(vectors) };
}

/**
 * SPEC §62 — the address itself is never stored, only a keyed digest.
 *
 * `IP_PEPPER` is a Worker secret, per environment, and is what makes the digest a pseudonym
 * rather than an encoding: IPv4 is small enough to enumerate against any salt an attacker
 * can guess, and an environment name — which is what stood here — is not a secret at all.
 *
 * The fallback is the environment name, deliberately and only so that a deployment missing
 * the secret keeps counting: the pseudonym is the flood key for an anonymous caller (§59.1),
 * and returning null instead would put every anonymous request in the world in one bucket.
 * A deployment running on the fallback has §62's protection in name only — set the secret.
 */
const pepperFor = (env: Env): string => env.IP_PEPPER ?? env.ENVIRONMENT;

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
  const ipHash = await addressPseudonym(request.headers.get("cf-connecting-ip"), pepperFor(env));
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

import { ErrorType, type ErrorTypeName } from "@orator/protocol";
import type {
  ArticleRepo,
  AuditRepo,
  Clock,
  ContentStore,
  Database,
  EventBus,
  EventRepo,
  IdempotencyRepo,
  IdGen,
  KeyRepo,
  MediaRepo,
  MediaStore,
  Metrics,
  ModerationRepo,
  OutboxRepo,
  CredentialRepo,
  PrincipalRepo,
  QuotaGate,
  SessionRepo,
  ReadingRepo,
  SearchIndex,
  SocialRepo,
  TokenRepo,
  TopicRepo,
} from "../ports/index.js";
import type { Actor } from "../identity/authz.js";
import type { QuotaAction, QuotaVerdict } from "../identity/quota.js";
import type { AudienceClass } from "../observability/audience.js";

/** Everything a service is allowed to reach. Assembled once per request by the adapter. */
export interface Ports {
  db: Database;
  principals: PrincipalRepo;
  tokens: TokenRepo;
  keys: KeyRepo;
  audit: AuditRepo;
  outbox: OutboxRepo;
  eventBus: EventBus;
  articles: ArticleRepo;
  /** The public read model (SPEC §49). Separate from `articles`; see ports/reading.ts. */
  reading: ReadingRepo;
  /** SPEC §17, §18, §19 — comments, edges and follows. */
  social: SocialRepo;
  /** SPEC §38 — derived, rebuildable, and updated outside the write transaction. */
  search: SearchIndex;
  /** SPEC §22 — a curated vocabulary, read-only in the MVP. */
  topics: TopicRepo;
  /** SPEC §21 — the media record; the bytes are `mediaStore`. */
  media: MediaRepo;
  /** SPEC §21.1 — one streamed pass, counted, hashed and sniffed on the way in. */
  mediaStore: MediaStore;
  /** SPEC §61 — report intake. */
  moderation: ModerationRepo;
  /**
   * SPEC §9.2, §23.5 — browser credentials and sessions.
   *
   * Reached from the API surface only by account closure, which has to revoke every way in
   * rather than the ones its own adapter happens to know about. A closure that left the
   * passkey working would have closed nothing.
   */
  credentials: CredentialRepo;
  sessions: SessionRepo;
  events: EventRepo;
  /** SPEC §66.2 — fire and forget, and never to D1. */
  metrics: Metrics;
  /** SPEC §59.1 — the exact, global counter. Flood protection lives at the HTTP edge. */
  quota: QuotaGate;
  idempotency: IdempotencyRepo;
  content: ContentStore;
  clock: Clock;
  ids: IdGen;
}

export interface RequestContext {
  ports: Ports;
  /**
   * SPEC §66.5 — who is asking, decided once per request.
   *
   * On the context rather than recomputed where a metric is written: §66.5 requires the
   * dimension on every metric without exception, and a value derived independently at each
   * call site is a value that will eventually disagree with itself.
   */
  audience: AudienceClass;
  /** Travels from the HTTP edge through the outbox to the queue consumer (SPEC §66.1). */
  requestId: string;
  /** Null when the caller is not authenticated. */
  actor: Actor | null;
  tokenId: string | null;
  ipHash: string | null;
  userAgent: string | null;
}

/**
 * Services return failures instead of throwing them.
 *
 * A denied authorisation and a duplicate username are ordinary outcomes, not exceptions,
 * and the HTTP layer has to render each as a specific problem document (SPEC §45). Making
 * them values keeps that mapping total rather than dependent on catching the right thing.
 */
export interface ServiceError {
  type: ErrorTypeName;
  title: string;
  detail?: string;
  extra?: Record<string, unknown>;
  /**
   * How long the caller should wait, when the answer is knowable rather than a guess.
   *
   * §45.1 requires `Retry-After` on every 429. The HTTP layer has a default per error type,
   * which is the right thing for "the service is unavailable" and the wrong thing for a
   * quota: the window's real reset time is known exactly, and telling an agent to come back
   * in an hour when the allowance returns in ninety seconds wastes an hour of its work.
   */
  retryAfter?: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(
  type: ErrorTypeName,
  title: string,
  detail?: string,
  extra?: Record<string, unknown>,
  retryAfter?: number,
): Result<T> => ({
  ok: false,
  error: {
    type,
    title,
    ...(detail === undefined ? {} : { detail }),
    ...(extra === undefined ? {} : { extra }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  },
});

/**
 * Charges one use against a principal's quota, or refuses (SPEC §59.2).
 *
 * Written once because the shape of the refusal is part of the contract: §59.2 requires a
 * `429` carrying `Retry-After` and the quota structure, and a route that assembled its own
 * would eventually assemble a different one. The `Retry-After` is the window's real reset
 * rather than a per-type default — telling an agent to come back in an hour when its
 * allowance returns in ninety seconds throws away an hour of its work.
 *
 * Call it after authorisation and before the write. Before, and the wrong principal is
 * charged; after, and a refusal arrives with the row already created.
 */
export async function withinQuota(
  ctx: RequestContext,
  action: QuotaAction,
  chargeTo?: string,
): Promise<Result<QuotaVerdict>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  const principalId = chargeTo ?? actor.principalId;
  const verdict = await ctx.ports.quota.consume(principalId, action, actor.trustLevel);

  if (!verdict.metered) {
    // Allowed, because §61's rule for an unavailable dependency is to degrade the
    // consequence rather than block the caller — and never silently, because a limit that
    // did not apply is exactly what an attacker who can break the counter is after.
    console.error(
      JSON.stringify({
        level: "error",
        event: "quota.unmetered",
        request_id: ctx.requestId,
        principal_id: principalId,
        action,
      }),
    );
    return ok(verdict);
  }

  if (verdict.allowed) return ok(verdict);

  return fail(
    ErrorType.QuotaExceeded,
    "Quota exceeded",
    `${verdict.limit} per ${verdict.window} for ${action}. The allowance returns at ${verdict.resetAt}.`,
    { quota: verdict },
    verdict.retryAfterSeconds,
  );
}

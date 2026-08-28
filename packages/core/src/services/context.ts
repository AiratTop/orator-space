import { ErrorType, type ErrorTypeName, type OratorId } from "@orator/protocol";
import type { PendingWrite } from "../ports/index.js";
import type {
  ArticleRepo,
  AssetStore,
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
  ReadingListRepo,
  SessionRepo,
  ReadingRepo,
  SearchIndex,
  SitemapRepo,
  SloRepo,
  SocialRepo,
  TokenRepo,
  TopicAssignmentRepo,
  TopicRepo,
} from "../ports/index.js";
import type { Actor } from "../identity/authz.js";
import { unmetered, type QuotaAction, type QuotaVerdict } from "../identity/quota.js";
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
  /** SPEC §22 — a curated vocabulary; nothing in a request writes to it. */
  topics: TopicRepo;
  /**
   * SPEC §22.3 — where the classifier's output lands.
   *
   * Separate from `topics` so that the web's read-only slice stays read-only: a page renders
   * untrusted content, and the surface that does it should not hold the ability to write the
   * taxonomy that untrusted content is sorted into.
   */
  topicAssignments: TopicAssignmentRepo;
  /** SPEC §49.2, ADR 0011 — one person's private list, never counted in public. */
  readingList: ReadingListRepo;
  /** SPEC §21 — the media record; the bytes are `mediaStore`. */
  media: MediaRepo;
  /** SPEC §21.1 — one streamed pass, counted, hashed and sniffed on the way in. */
  mediaStore: MediaStore;
  /** SPEC §61 — report intake. */
  moderation: ModerationRepo;
  /** SPEC §51 — which shards need rebuilding, and where the built files go. */
  sitemap: SitemapRepo;
  /**
   * SPEC §66.4 — what the pipeline looks like from inside.
   *
   * A read model for an operator rather than for a reader: the depth of the backlog, how long
   * publishing takes to become findable, what the consumer gave up on, how much of D1's
   * ceiling is used. Here rather than beside `metrics` because none of it is a metric — every
   * one of these is state the database already holds, which is why six of §66.4's seven rows
   * need no metrics backend to answer.
   */
  slo: SloRepo;
  assets: AssetStore;
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

/**
 * The slice of `Ports` the account-administration services touch (SPEC §28, §49.2).
 *
 * The web surface has to write for `/settings` to exist at all: an agent registered, a
 * token issued, a session ended. What it must not gain in the process is the ability to
 * publish. `ports.ts` states the rule — a page reaches a narrowed set, so a write it has no
 * business making is absent rather than merely discouraged — and this is that rule applied
 * to the one surface that now writes. There is no `articles`, no `search`, no `media` and
 * no `sitemap` here, so no page can reach them.
 */
export type AccountPorts = Pick<
  Ports,
  | "db"
  | "principals"
  | "tokens"
  | "keys"
  | "audit"
  | "outbox"
  | "quota"
  | "sessions"
  | "credentials"
  | "reading"
  | "clock"
  | "ids"
>;

/**
 * The slice a comment needs (SPEC §17, §28, §49.3).
 *
 * The web page that renders a conversation should be able to join it, and until now the only
 * way in was the API. What that must not cost is the guarantee `ports.ts` states: the surface
 * that renders untrusted content cannot publish an article. So `articles` is narrowed to the
 * one method a comment reads with — a comment checks that its subject exists and is
 * published, and has no business writing a revision.
 */
export type CommentPorts = Pick<
  Ports,
  "db" | "principals" | "social" | "events" | "outbox" | "metrics" | "quota" | "clock" | "ids"
> & { articles: Pick<ArticleRepo, "findById"> };

export interface CommentContext extends Omit<RequestContext, "ports"> {
  ports: CommentPorts;
}

/**
 * The slice moderation needs (SPEC §61.1, §28).
 *
 * §61.1 requires a review queue "available to moderators", and until now it existed only as
 * a REST endpoint — a moderator worked by hand with curl, which is an obligation with no
 * surface and therefore an obligation nobody meets.
 *
 * The narrowing is the interesting part. `articles` is four methods and none of them writes
 * a revision: a moderator may unpublish, tombstone or de-index somebody's article, and may
 * not rewrite it. That is exactly the authority §61.1 grants, expressed as what the surface
 * can reach rather than as a rule it is asked to follow.
 */
export type ModerationPorts = Pick<
  Ports,
  "db" | "principals" | "moderation" | "audit" | "outbox" | "events" | "clock" | "ids"
> & {
  articles: Pick<ArticleRepo, "findById" | "setStatus" | "unpublish" | "updateMetadata">;
  social: Pick<SocialRepo, "findComment" | "setCommentStatus">;
  media: Pick<MediaRepo, "findById" | "markRejected">;
};

export interface ModerationContext extends Omit<RequestContext, "ports"> {
  ports: ModerationPorts;
}

export interface AccountContext extends Omit<RequestContext, "ports"> {
  ports: AccountPorts;
}

/**
 * What a quota check reads, which is two ports and the actor.
 *
 * Narrowed so that a surface holding a slice of `Ports` can still be metered. A quota that
 * only the full-`Ports` surface could check would be a quota the other surface does not
 * have — which is how an unmetered path appears without anyone deciding to create one.
 */
export interface QuotaContext {
  ports: Pick<Ports, "quota" | "clock">;
  actor: Actor | null;
  requestId: string;
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
 * An audit row for the change it accompanies, in the same commit (SPEC §35, §62).
 *
 * Here rather than in `identity.ts`, where it was, because `account.ts` needs the identical
 * row and a second copy would be a second set of field names for the same table — the kind
 * of duplication that stays consistent right up until one of them gains a field.
 */
export function journal(
  ctx: AccountContext,
  action: string,
  target: { type: string; id: string },
  outcome: "success" | "denied",
  reason: string | null,
): PendingWrite {
  return ctx.ports.audit.record({
    id: ctx.ports.ids.next(),
    actorPrincipalId: (ctx.actor?.principalId ?? null) as OratorId | null,
    actorTokenId: ctx.tokenId,
    action,
    targetType: target.type,
    targetId: target.id,
    outcome,
    reason,
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    createdAt: ctx.ports.clock.now().toISOString(),
  });
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
  ctx: QuotaContext,
  action: QuotaAction,
  chargeTo?: string,
): Promise<Result<QuotaVerdict>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  /*
   * §66.7 — the canary is exempt, and it has to be.
   *
   * The deep check publishes every few minutes and §59.2 allows twenty articles a day, so a
   * metered canary would stop reporting after an hour and the outage it exists to detect
   * would look like a quota. The exemption is narrow by construction: it applies to a
   * principal an operator flagged in the database, and to nothing a caller can claim.
   */
  if (actor.systemAccount) {
    return ok(unmetered(action, actor.trustLevel, ctx.ports.clock.now()));
  }

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

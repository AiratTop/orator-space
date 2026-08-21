import type { ErrorTypeName } from "@orator/protocol";
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
  OutboxRepo,
  PrincipalRepo,
  TokenRepo,
} from "../ports/index.js";
import type { Actor } from "../identity/authz.js";

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
  events: EventRepo;
  idempotency: IdempotencyRepo;
  content: ContentStore;
  clock: Clock;
  ids: IdGen;
}

export interface RequestContext {
  ports: Ports;
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
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(
  type: ErrorTypeName,
  title: string,
  detail?: string,
  extra?: Record<string, unknown>,
): Result<T> => ({
  ok: false,
  error: { type, title, ...(detail === undefined ? {} : { detail }), ...(extra === undefined ? {} : { extra }) },
});

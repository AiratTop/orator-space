import { env } from "cloudflare:workers";
import { isMintedId } from "@orator/protocol";
import type { QuotaCounter } from "@orator/adapters-cf";
import {
  createArticleRepo,
  createAuditRepo,
  createD1Database,
  createIdGen,
  createKeyRepo,
  createOutboxRepo,
  createPrincipalRepo,
  createQuotaGate,
  createReadingListRepo,
  createReadingRepo,
  createSessionRepo,
  createMediaRepo,
  createTelegramRepo,
  createR2MediaStore,
  createModerationRepo,
  createSocialRepo,
  createEventRepo,
  createTokenRepo,
  createCredentialRepo,
  systemClock,
} from "@orator/adapters-cf";
import {
  addressPseudonym,
  sessionActor,
  type AccountContext,
  type AccountPorts,
  type CommentContext,
  type CommentPorts,
  type AvatarContext,
  type AvatarPorts,
  type ModerationContext,
  type ModerationPorts,
  type PrincipalRecord,
} from "@orator/core";
import { authPorts } from "./auth.js";

/**
 * The writes `/settings` is allowed to make (SPEC §28, §49.2).
 *
 * The web surface was read-only apart from signing in, and `ports.ts` says why: a page
 * renders untrusted content, so what it must not do is absent rather than merely
 * discouraged. `/settings` needs to write — an agent registered, a token issued, a session
 * ended — and this is that need met without widening the surface: `AccountPorts` has no
 * `articles`, no `search`, no `media` and no `sitemap`, so no page can reach them however
 * it is written.
 */
interface AccountEnv {
  DB: D1Database;
  /**
   * The edge Worker's namespace, reached across scripts (§59.1).
   *
   * Absent in local development, where a cross-Worker Durable Object needs the other Worker
   * in the same session. `createQuotaGate` already answers an unreachable counter the way
   * §59.1 says to — allow the write, log `quota.unavailable` — so the local gap is loud
   * rather than silent.
   */
  QUOTA: DurableObjectNamespace<QuotaCounter>;
  ENVIRONMENT: string;
  /** SPEC §62 — the pepper the edge Worker uses, so both surfaces produce one pseudonym. */
  IP_PEPPER?: string;
}

const accountEnv = env as unknown as AccountEnv;
const ids = createIdGen();

export const accountPorts: AccountPorts = {
  db: createD1Database(accountEnv.DB),
  principals: createPrincipalRepo(accountEnv.DB),
  tokens: createTokenRepo(accountEnv.DB),
  keys: createKeyRepo(accountEnv.DB),
  audit: createAuditRepo(accountEnv.DB),
  outbox: createOutboxRepo(accountEnv.DB),
  quota: createQuotaGate(accountEnv.QUOTA),
  sessions: createSessionRepo(accountEnv.DB),
  credentials: createCredentialRepo(accountEnv.DB),
  // §9.1 — read for one question: does this account have a second way in, so that removing
  // the last passkey is a decision rather than a lockout.
  telegram: createTelegramRepo(accountEnv.DB),
  reading: createReadingRepo(accountEnv.DB),
  readingList: createReadingListRepo(accountEnv.DB),
  clock: systemClock,
  ids,
};

/**
 * The context a page acts in, on behalf of the person whose cookie arrived.
 *
 * `tokenId` is null and stays null: there is no API token here, and the audit row saying so
 * is the difference between "she did this in a browser" and "something holding her
 * credential did this" (§62).
 */
/**
 * The same rule the API applies (§66.1): the caller's id if it is one, or one minted here.
 *
 * Checked and not merely accepted, for the reason the edge Worker checks it — the value ends
 * up in `audit_log` and in every outbox payload, and a header nobody validated is caller-
 * chosen text in both. A browser sends no such header, so in practice this mints; the check
 * is for everything else that can reach a page.
 */
function requestIdOf(request: Request): string {
  const offered = request.headers.get("x-request-id");
  return offered !== null && isMintedId(offered) ? offered : ids.next();
}

export function accountContext(request: Request, principal: PrincipalRecord): AccountContext {
  return {
    ports: accountPorts,
    requestId: requestIdOf(request),
    actor: sessionActor(principal),
    tokenId: null,
    ipHash: null,
    userAgent: request.headers.get("user-agent"),
    audience: "human_web",
  };
}

/**
 * SPEC §57.3 — a same-origin check on every write from a page.
 *
 * The session cookie is `SameSite=Lax`, which already keeps a browser from attaching it to
 * a cross-site form post, so this is the second lock rather than the first. It is here
 * because the first one is a browser's behaviour and this one is ours: a rule that lives in
 * the code holds on a client that gets Lax wrong, and costs a header comparison.
 */
export function sameOrigin(request: Request, origin: string): boolean {
  const stated = request.headers.get("origin");
  if (stated !== null) return stated === origin;
  // No `Origin` at all is not a pass. Every browser that can run a passkey ceremony sends
  // one on a form post; a request without it is not the surface this page is written for.
  return false;
}

/** Who is asking, resolved to the full record the services need. */
export async function principalOf(principalId: string): Promise<PrincipalRecord | null> {
  return authPorts.principals.findById(principalId);
}


/**
 * The writes a comment form is allowed to make (SPEC §17, §28, §49.3).
 *
 * Separate from `accountPorts` and narrower than it in the direction that matters: `articles`
 * is `{ findById }` and nothing else, so a page can check that the article it is commenting
 * on exists and cannot write a revision. The rest is what §17's flow already touches — the
 * comment, the event, the outbox row and the quota that bounds it.
 *
 * Metrics are a no-op here rather than the Analytics Engine binding: §66.2 puts metrics on
 * the API surface, and a page writing to a dataset the API owns would make one number mean
 * two things.
 */
export const commentPorts: CommentPorts = {
  db: accountPorts.db,
  principals: accountPorts.principals,
  social: createSocialRepo(accountEnv.DB),
  events: createEventRepo(accountEnv.DB),
  outbox: accountPorts.outbox,
  quota: accountPorts.quota,
  articles: { findById: createArticleRepo(accountEnv.DB).findById },
  metrics: { write: () => undefined },
  clock: systemClock,
  ids,
};

export function commentContext(request: Request, principal: PrincipalRecord): CommentContext {
  return { ...accountContext(request, principal), ports: commentPorts };
}


/**
 * What a moderator may reach from a browser (SPEC §61.1, §28).
 *
 * §61.1 requires a review queue available to moderators, and it has existed only as a REST
 * endpoint — which means the obligation was met by a person willing to use curl. This is the
 * same set of operations behind a page.
 *
 * `articles` is four methods, and none of them writes a revision. A moderator may unpublish,
 * tombstone or de-index somebody's article and may not rewrite it, which is exactly the
 * authority §61.1 grants — expressed as what this surface can reach rather than as a rule it
 * is trusted to follow.
 */
export const moderationPorts: ModerationPorts = {
  db: accountPorts.db,
  principals: accountPorts.principals,
  moderation: createModerationRepo(accountEnv.DB),
  audit: accountPorts.audit,
  outbox: accountPorts.outbox,
  events: createEventRepo(accountEnv.DB),
  articles: (() => {
    const repo = createArticleRepo(accountEnv.DB);
    return {
      findById: repo.findById,
      setStatus: repo.setStatus,
      unpublish: repo.unpublish,
      updateMetadata: repo.updateMetadata,
    };
  })(),
  social: (() => {
    const repo = createSocialRepo(accountEnv.DB);
    return { findComment: repo.findComment, setCommentStatus: repo.setCommentStatus };
  })(),
  media: (() => {
    const repo = createMediaRepo(accountEnv.DB);
    return { findById: repo.findById, markRejected: repo.markRejected };
  })(),
  clock: systemClock,
  ids,
};

export function moderationContext(request: Request, principal: PrincipalRecord): ModerationContext {
  return { ...accountContext(request, principal), ports: moderationPorts };
}

/**
 * The context a report is filed in — by anybody, signed in or not (SPEC §61.2).
 *
 * Separate from `moderationContext` because of the one difference that matters: the actor is
 * nullable. §61.2 refuses to make an account the price of reporting illegal content, and it
 * is right for a second reason — the person best placed to report something is often the one
 * it is about, who has no reason to hold an account here.
 *
 * The address is hashed and carried, which no other write from this surface does. Everywhere
 * else the audit row names a principal; here there may be none, so a salted digest is the
 * only thing distinguishing "many people are reporting this" from "one script is". The salt
 * is the environment name, matching the API surface (§62) — weak as salts go, and what keeps
 * the two deployments' hashes from being comparable.
 */
export async function reportContext(
  request: Request,
  principal: PrincipalRecord | null,
): Promise<ModerationContext> {
  return {
    ports: moderationPorts,
    requestId: requestIdOf(request),
    actor: principal === null ? null : sessionActor(principal),
    tokenId: null,
    ipHash: await hashAddress(request.headers.get("cf-connecting-ip")),
    userAgent: request.headers.get("user-agent"),
    audience: "human_web",
  };
}

/**
 * A report this reader already has open against this target (SPEC §61.1).
 *
 * The service deduplicates on the same key and answers with the report that already exists,
 * which is the right behaviour for an API caller and the wrong thing to *only* do for a
 * person: they would fill in a form, press send, and be shown a confirmation carrying a
 * timestamp from last week without ever being told why. Asked before the form is drawn, the
 * same fact becomes an answer instead of a surprise.
 */
export async function openReportBy(
  reporterPrincipalId: string,
  targetType: string,
  targetId: string,
) {
  return moderationPorts.moderation.findOpenReportBy(reporterPrincipalId, targetType, targetId);
}

/**
 * SPEC §62 — an address is stored as a keyed digest or not at all.
 *
 * The same pepper and the same function as the edge Worker (`apps/edge/src/context.ts`), so
 * one caller reaching both surfaces is one pseudonym in the audit log rather than two. The
 * fallback to the environment name, and what it costs, is documented there.
 */
function hashAddress(address: string | null): Promise<string | null> {
  return addressPseudonym(address, accountEnv.IP_PEPPER ?? accountEnv.ENVIRONMENT);
}


/**
 * What an avatar upload may reach (SPEC §21.1, §28, §49.4).
 *
 * The first time the public web is handed a way to write bytes, and the narrowest set that
 * makes it possible: the media record, the object store, the quota that bounds it, and the
 * principal row the id lands on. No `articles`, so a surface that can accept a picture still
 * cannot publish one.
 */
const avatarEnv = env as unknown as { MEDIA: R2Bucket };

export const avatarPorts: AvatarPorts = {
  db: accountPorts.db,
  principals: accountPorts.principals,
  media: createMediaRepo(accountEnv.DB),
  mediaStore: createR2MediaStore(avatarEnv.MEDIA),
  outbox: accountPorts.outbox,
  quota: accountPorts.quota,
  metrics: { write: () => undefined },
  clock: systemClock,
  ids,
};

/**
 * What the Telegram link needs, and nothing else (SPEC §9.3, §28).
 *
 * Three things: the nonce table, a transaction and a clock. No principals repository — the
 * binding names the principal from the session, and a surface that could look one up could
 * issue a link for somebody else.
 */
export const telegramPorts = {
  telegram: createTelegramRepo(accountEnv.DB),
  db: accountPorts.db,
  clock: systemClock,
};

export function avatarContext(request: Request, principal: PrincipalRecord): AvatarContext {
  return { ...accountContext(request, principal), ports: avatarPorts };
}

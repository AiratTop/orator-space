import { env } from "cloudflare:workers";
import type { QuotaCounter } from "@orator/adapters-cf";
import {
  createAuditRepo,
  createD1Database,
  createIdGen,
  createKeyRepo,
  createOutboxRepo,
  createPrincipalRepo,
  createQuotaGate,
  createReadingRepo,
  createSessionRepo,
  createTokenRepo,
  createCredentialRepo,
  systemClock,
} from "@orator/adapters-cf";
import { sessionActor, type AccountContext, type AccountPorts, type PrincipalRecord } from "@orator/core";
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
  reading: createReadingRepo(accountEnv.DB),
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
export function accountContext(request: Request, principal: PrincipalRecord): AccountContext {
  return {
    ports: accountPorts,
    // The same rule the API applies: an id supplied by the caller, or one minted here. It
    // is what ties an audit row to the request that produced it (§66.1).
    requestId: request.headers.get("x-request-id") ?? ids.next(),
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

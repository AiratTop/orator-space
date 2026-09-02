import { ErrorType, SCHEMA_VERSION, type OratorId } from "@orator/protocol";
import type { PendingWrite } from "../ports/index.js";
import { fail, ok, type Ports, type RequestContext, type Result } from "./context.js";

/**
 * Closing an account (SPEC §23.5).
 *
 * §23.5 opens by saying what this is not: *closing a person's account is a distinct
 * operation, not a matter of deleting articles.* The two are separable and have to be,
 * because they have different subjects. Closing an account is about the person — their
 * credentials, their personal data, their ability to act. What happens to the work they
 * published is a second question, and §23.5 gives them three answers to choose between.
 *
 * The order below is the order of §23.5's own list, and it is not arbitrary: revocation
 * comes before anything slow, so that a compromised account stops being usable at the
 * first opportunity rather than the last.
 */

export type ArticleDisposition = "pseudonymise" | "unpublish" | "erase";

export interface CloseAccountInput {
  /** Required verbatim. The username is not released for a year and the tokens are gone. */
  confirm: string;
  articles: ArticleDisposition;
  reason?: string | null;
}

export interface ClosureOutcome {
  principalId: OratorId;
  tokensRevoked: number;
  agentsSuspended: number;
  articles: ArticleDisposition;
  /** SPEC §23.5 — the earliest date the username could be given to somebody else. */
  usernameReservedUntil: string;
}

/** SPEC §23.5 — "at least 12 months", stated as a date the caller can read. */
const USERNAME_RESERVATION_MONTHS = 12;

export async function closeAccount(
  ctx: RequestContext,
  principalId: string,
  input: CloseAccountInput,
): Promise<Result<ClosureOutcome>> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");

  if (input.confirm !== "close") {
    return fail(
      ErrorType.ValidationFailed,
      "Closure must be confirmed",
      'Send {"confirm":"close"}. Every token and passkey is revoked and the username is not ' +
        "released for a year.",
      { field: "confirm" },
    );
  }

  const principal = await ctx.ports.principals.findById(principalId);
  if (principal === null || principal.status === "deleted") {
    return fail(ErrorType.NotFound, "Principal not found");
  }

  /*
   * The kind is checked before the permission, and that order is deliberate.
   *
   * §7.2 publishes whether a principal is a human or an agent, so saying "an agent has no
   * account to close" leaks nothing. Checking permission first would answer `403` to an
   * owner asking about their own agent — technically true and useless, because the reason
   * is not that they lack the right but that the operation does not apply.
   */
  if (principal.kind !== "human") {
    return fail(
      ErrorType.ValidationFailed,
      "An agent has no account to close",
      "Suspend it through moderation, or close the account of the human who owns it (§7.2).",
    );
  }

  /*
   * The account holder, or an administrator. Not the owner of an agent.
   *
   * §23.5 is about a person's account. An agent is suspended as a consequence of its owner
   * closing theirs (step 3 below) and has nothing of its own to close: no credentials to
   * revoke that its owner did not issue, and no personal data, because it is not a person.
   */
  const isSelf = principal.id === actor.principalId;
  if (!isSelf && actor.platformRole !== "admin") {
    return fail(ErrorType.Forbidden, "Not permitted", "An account is closed by its holder.");
  }

  const now = ctx.ports.clock.now();
  const at = now.toISOString();
  const agents = await ctx.ports.principals.listAgentsOwnedBy(principal.id);

  const writes: PendingWrite[] = [
    // 1 — the principal is closed. The username stays on the row, which is what reserves it.
    ctx.ports.principals.setStatus(principal.id, "deleted", at),

    // 2 — every credential, and every credential of every agent they operate. An agent's
    // token was issued by this person and grants what this person granted; leaving it live
    // would leave the account acting after it was closed.
    ctx.ports.tokens.revokeAllFor(principal.id, at),
    ctx.ports.sessions.revokeAllFor(principal.id, at),
    ctx.ports.credentials.deleteAllFor(principal.id),
    /*
     * §23.5, ADR 0011 — a reading list goes with the account.
     *
     * Deleted rather than kept: it is one person's private notes about their own reading,
     * it is not evidence of anything and nothing else in the system reads it. Keeping it
     * would keep a record of what somebody read after they asked to be forgotten.
     */
    ctx.ports.readingList.removeAllFor(principal.id),

    // 5 — the personal data. The row survives because it is a foreign key target for
    // articles, comments, edges and audit entries.
    ctx.ports.principals.blankHumanAccount(principal.id, at),
  ];

  for (const agent of agents) {
    // 3 — suspended, not deleted. §23.5 is explicit that closing an owner's account does not
    // destroy what their agents published, because that would tear the citation graph for
    // third parties who cited it.
    writes.push(ctx.ports.principals.setStatus(agent.id, "suspended", at));
    writes.push(ctx.ports.tokens.revokeAllFor(agent.id, at));
  }

  /*
   * 4 — the articles, asynchronously.
   *
   * Not in this transaction. A person closing an account may have published hundreds of
   * articles, and erasing one is an R2 read, a refcount check and a delete (§23.3) — work
   * that does not fit in a request and must not make "let me out" time out. The disposition
   * travels on the event and the queue applies it.
   *
   * The account is closed either way. Whatever happens to the writing, the credentials are
   * gone before this function returns.
   */
  writes.push(
    ctx.ports.outbox.enqueue({
      id: ctx.ports.ids.next(),
      eventType: "principal.closed",
      aggregateType: "principal",
      aggregateId: principal.id,
      payload: {
        schema_version: SCHEMA_VERSION,
        articles: input.articles,
        agent_principal_ids: agents.map((agent) => agent.id),
      },
      requestId: ctx.requestId,
      createdAt: at,
    }),
    // 6 — §62. The audit row outlives the account and is pseudonymised on the §23.4
    // schedule; this is the entry that says the closure was asked for rather than done to
    // somebody.
    ctx.ports.audit.record({
      id: ctx.ports.ids.next(),
      actorPrincipalId: actor.principalId as OratorId,
      actorTokenId: ctx.tokenId,
      action: "account.closed",
      targetType: "principal",
      targetId: principal.id,
      outcome: "success",
      reason: input.reason ?? input.articles,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      createdAt: at,
    }),
  );

  await ctx.ports.db.commit(writes);

  const reserved = new Date(now);
  reserved.setUTCMonth(reserved.getUTCMonth() + USERNAME_RESERVATION_MONTHS);

  return ok({
    principalId: principal.id,
    tokensRevoked: (await ctx.ports.tokens.listFor(principal.id)).length,
    agentsSuspended: agents.length,
    articles: input.articles,
    usernameReservedUntil: reserved.toISOString(),
  });
}

/**
 * Applies the article disposition a closure asked for (SPEC §23.5 step 4).
 *
 * Runs from the queue. Bounded per pass and re-entrant: at-least-once delivery means this
 * may run twice, and every branch below is idempotent — an unpublished article unpublishes
 * to the same state, and an erased one has nothing left to erase.
 */
export async function applyClosureDisposition(
  ports: Ports,
  principalId: string,
  disposition: ArticleDisposition,
  agentPrincipalIds: readonly string[],
  limit = 100,
): Promise<{ handled: number; moreToDo: boolean }> {
  /*
   * `pseudonymise` is the default and is deliberately a no-op on the articles.
   *
   * The name an article carries is a username, and a username was never personal data — it
   * is the handle the work was published under and the thing citations point at (§7.3).
   * The account row identifies nobody by itself — it holds no address (ADR 0016) — and what
   * tied it to a person was the credentials, deleted at step 1. So "keep under a pseudonym"
   * is a description of what has already happened rather than a further operation: the
   * writing stays, attributed to a name that no longer reaches anybody.
   */
  if (disposition === "pseudonymise") return { handled: 0, moreToDo: false };

  const authors = [principalId, ...agentPrincipalIds];
  const at = ports.clock.now().toISOString();
  let handled = 0;

  for (const author of authors) {
    const articles = await ports.articles.listByAuthor(author, limit - handled);
    for (const article of articles) {
      if (article.status === "removed") continue;

      if (disposition === "unpublish") {
        await ports.db.commit([ports.articles.unpublish(article.id, at)]);
      } else {
        // §23.3 — the tombstone stays and the bytes go. Erasure is refcounted, so an object
        // shared with another revision is not removed here; that is `eraseArticle`'s job and
        // it is not reimplemented.
        await ports.db.commit([ports.articles.setStatus(article.id, "removed", at, "author")]);
      }

      await ports.db.commit([
        ports.outbox.enqueue({
          id: ports.ids.next(),
          eventType: disposition === "unpublish" ? "article.unpublished" : "article.removed",
          aggregateType: "article",
          aggregateId: article.id,
          payload: { schema_version: SCHEMA_VERSION, cause: "account_closed" },
          requestId: null,
          createdAt: at,
        }),
      ]);
      handled += 1;
      if (handled >= limit) return { handled, moreToDo: true };
    }
  }

  return { handled, moreToDo: false };
}

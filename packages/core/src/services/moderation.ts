import { ErrorType, SCHEMA_VERSION, type OratorId } from "@orator/protocol";
import type {
  ModerationActionKind,
  ModerationActionRecord,
  PendingWrite,
  ReportCategory,
  ReportRecord,
  ReportStatus,
  ReportTarget,
  TargetSummary,
} from "../ports/index.js";
import { canModerate } from "../identity/authz.js";
import { HEURISTIC_PROVIDER, screen, type ModerationVerdict } from "../moderation/heuristics.js";
import {
  fail,
  ok,
  type ModerationContext,
  type Ports,
  type Result,
} from "./context.js";

/**
 * Report intake (SPEC §61).
 *
 * Only intake. Review, the moderation queue and the actions taken on a report are §61's
 * launch-gate work; what has to exist first is somewhere for a report to land, because a
 * platform that hosts machine-generated content and offers no way to complain about it is
 * not one anybody should be asked to trust.
 */

export interface CreateReportInput {
  targetType: "article" | "comment" | "principal" | "media";
  targetId: string;
  category: ReportCategory;
  details?: string | null;
  reporterContact?: string | null;
}

/** Reports about one target within this window are collapsed rather than piled up. */
const FLOOD_WINDOW_MS = 60 * 60 * 1000;
const FLOOD_LIMIT = 20;

export async function createReport(
  ctx: ModerationContext,
  input: CreateReportInput,
): Promise<Result<{ id: OratorId; status: "open"; createdAt: string }>> {
  /**
   * Anonymous on purpose (§61.2).
   *
   * Requiring an account to report illegal content is not acceptable, and it is also
   * self-defeating: the person best placed to report a piece of content is frequently the
   * one it is about, who has no reason to hold an account here.
   */
  const now = ctx.ports.clock.now().toISOString();

  const subject = await resolveTarget(ctx, input.targetType, input.targetId);
  if (subject === null) return fail(ErrorType.NotFound, "Nothing to report at that identifier");

  /*
   * Nobody reports themselves, or anything they answer for (§7.2, §61.1).
   *
   * A report asks a moderator to act on content somebody else controls. Against your own
   * account, your own article, or one published by an agent you own, there is nothing to ask
   * for: §7.2 makes you the accountable party, and every verb a moderator has — unpublish,
   * remove, close the account — is already yours to use. What a report would add is a row in
   * a queue asking a stranger to do what you can do yourself, and a signal that reads to them
   * like somebody else's complaint.
   *
   * The agent case is the one worth stating. It looks like a third party and is not: your
   * agent's article is published under your accountability, so reporting it is reporting
   * yourself with an extra step.
   *
   * **This is queue hygiene, not a security control, and the difference matters.** Reports
   * are anonymous by design (§61.2) — an author who signs out can file one about their own
   * article and it will be accepted, exactly as a stranger's would be. That is the correct
   * trade: refusing anonymous reports to close this would fail the person §61.2 was written
   * for. What the rule buys is that the surfaces stop offering an action that means nothing,
   * and the queue stops carrying rows whose reporter and subject are the same party.
   */
  if (subject.authorPrincipalId !== null && (await isAccountableFor(ctx, subject.authorPrincipalId))) {
    return fail(
      ErrorType.Forbidden,
      "You answer for this already",
      "Reporting asks a moderator to act on somebody else's content. This is yours, or your agent's — the actions a moderator would take are ones you can take yourself.",
    );
  }

  /*
   * One open report per reporter per target (§61.1).
   *
   * The flood counter below bounds how often a *target* can be reported and cannot see one
   * person filing about it repeatedly: twenty rows from one account is under that ceiling and
   * is exactly the shape abuse takes. A moderator reading the queue then sees a target that
   * looks widely complained about and is not, which is the harm — a report's weight comes
   * from independent people noticing the same thing.
   *
   * **The existing report is returned rather than a refusal.** Nothing in the error catalogue
   * fits: `conflict` and `rate-limited` are both documented as retryable (§45.1) and retrying
   * this will not help, so answering with either would put a lie in the contract an agent acts
   * on. Returning the report they already filed is true, needs no new code, and tells a client
   * the thing it actually wants to know — that this is on the record — while creating no
   * second row. The `created_at` in the response is the first report's, which is the one fact
   * that distinguishes the two cases for a caller who cares.
   *
   * Only for a reporter with an account: an anonymous report has nobody to be the same person
   * as (§61.2). Those are bounded by the flood counter and, on the web, by the per-address
   * limiter the form applies.
   */
  const reporter = ctx.actor?.principalId ?? null;
  if (reporter !== null) {
    const already = await ctx.ports.moderation.findOpenReportBy(
      reporter,
      input.targetType,
      input.targetId,
    );
    if (already !== null) {
      return ok({ id: already.id, status: "open", createdAt: already.createdAt });
    }
  }

  const since = new Date(Date.parse(now) - FLOOD_WINDOW_MS).toISOString();
  const recent = await ctx.ports.moderation.countRecentReports(input.targetType, input.targetId, since);
  if (recent >= FLOOD_LIMIT) {
    // The report is refused, not the content exonerated. A target already at the limit is
    // firmly in the queue; what a hundred more rows would add is queue noise and a way to
    // fill the table from outside.
    return fail(
      ErrorType.RateLimited,
      "This content has already been reported many times",
      "It is in the moderation queue. Further reports about it are not recorded for now.",
    );
  }

  const id = ctx.ports.ids.next();
  await ctx.ports.db.commit([
    ctx.ports.moderation.insertReport({
      id,
      targetType: input.targetType,
      targetId: input.targetId,
      reporterPrincipalId: reporter as OratorId | null,
      reporterContact: input.reporterContact ?? null,
      category: input.category,
      details: input.details ?? null,
      createdAt: now,
    }),
    // Recorded in the audit log rather than in `events`: who reported what is a security
    // and legal fact, not public activity, and §20.3 keeps those in different tables.
    ctx.ports.audit.record({
      id: ctx.ports.ids.next(),
      actorPrincipalId: (ctx.actor?.principalId ?? null) as OratorId | null,
      actorTokenId: ctx.tokenId,
      action: "report.created",
      targetType: input.targetType,
      targetId: input.targetId,
      outcome: "success",
      reason: input.category,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
      createdAt: now,
    }),
    ctx.ports.outbox.enqueue({
      id: ctx.ports.ids.next(),
      eventType: "report.created",
      aggregateType: "report",
      aggregateId: id,
      payload: {
        schema_version: SCHEMA_VERSION,
        category: input.category,
        target_type: input.targetType,
        target_id: input.targetId,
      },
      requestId: ctx.requestId,
      createdAt: now,
    }),
  ]);

  return ok({ id, status: "open", createdAt: now });
}

/**
 * Whether the caller is the party §7.2 holds responsible for that principal.
 *
 * True for themselves, and for an agent they own. The second lookup happens only when the
 * ids differ, so the ordinary case — a stranger reporting a stranger — costs nothing.
 */
async function isAccountableFor(ctx: ModerationContext, subjectId: string): Promise<boolean> {
  const actor = ctx.actor?.principalId;
  // An anonymous report has no self to be about. §61.2 requires that path to stay open.
  if (actor === undefined || actor === null) return false;
  if (actor === subjectId) return true;

  const subject = await ctx.ports.principals.findById(subjectId);
  return subject?.kind === "agent" && subject.ownerPrincipalId === actor;
}

// ---------------------------------------------------------------------------
// The queue, and what is done from it (SPEC §61.1)
// ---------------------------------------------------------------------------

/**
 * Why an action was taken, as a short stable code.
 *
 * Codes rather than prose because the value reaches the author through an event (§61.2) and
 * has to be interpretable by an agent as well as readable by a person. The free-text
 * `reason_text` carries the explanation; this carries the category, and a client can act on
 * it without parsing English.
 */
export const REASON_CODES = [
  "spam",
  "illegal_content",
  "copyright",
  "abuse",
  "prompt_injection",
  "impersonation",
  "misleading_provenance",
  "duplicate",
  "legal_order",
  "other",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * Which verbs apply to which kind of target (SPEC §61.1, §23.2, §50.3).
 *
 * Exported because a surface offering an action the service must refuse is not a smaller
 * mistake than a service accepting one it should not. The queue offered de-index, hide, warn
 * and remove against every target regardless of type, which meant a report about an *account*
 * had four options and no usable one: `suspend` is the only verb that applies to a principal
 * and it was not on the list. A moderator's only route was to pick something and read the
 * refusal.
 *
 * `warn` is on every row because it changes nothing and exists so a warning is on the record
 * before an escalation is. `restore` is on every row because reversing is always available;
 * it is offered from the log rather than the queue, which is where the thing to reverse is.
 */
export const ACTIONS_FOR: Record<
  "article" | "comment" | "principal" | "media",
  readonly ModerationActionKind[]
> = {
  article: ["unindex", "hide", "remove", "warn", "restore"],
  comment: ["hide", "remove", "warn", "restore"],
  // §23.1 — a person is stopped from acting; their words are not taken down by the same verb.
  principal: ["suspend", "warn", "restore"],
  // §21.1 — `rejected` is a media record's only removal state, reached by either verb.
  media: ["hide", "remove", "warn", "restore"],
};

/** The word a person reads for a verb. Only one differs from the stored value. */
export const ACTION_LABEL: Record<ModerationActionKind, string> = {
  unindex: "de-index",
  hide: "hide",
  remove: "remove",
  suspend: "suspend the account",
  warn: "warn",
  restore: "restore",
};

export interface ReviewInput {
  reportId: string;
  /** `rejected` closes the report with no action; `reviewing` claims it. */
  status: "reviewing" | "rejected";
  resolution?: string | null;
}

export interface ActionInput {
  targetType: "article" | "comment" | "principal" | "media";
  targetId: string;
  action: ModerationActionKind;
  reasonCode: ReasonCode;
  reasonText?: string | null;
  source?: "report" | "legal" | "proactive";
  /** When the action closes a report, it is named and the report is closed with it. */
  reportId?: string | null;
}

/**
 * Who filed a page of reports (SPEC §61.1, §61.2).
 *
 * Moderator-only, like everything else in this file, and that gate is the whole of what makes
 * it acceptable. The reporter's identity is recorded as a security and legal fact (§20.3 keeps
 * it in `reports` and the audit log rather than in public activity), and a moderator needs it
 * for the one judgement they cannot make without it: whether five reports about one person are
 * five people or one. Nothing else on this platform ever shows it.
 *
 * **It is a real trade and worth naming.** A visible reporter is a retaliation channel where
 * the moderator is also a participant, and this deployment has one moderator who is also its
 * operator. The alternative — a queue that cannot tell a campaign from a consensus — is worse,
 * and the honest mitigation is that it stops at the queue rather than that it is hidden here.
 */
export async function describeReporters(
  ctx: ModerationContext,
  reports: readonly ReportRecord[],
): Promise<Result<Map<string, string>>> {
  const gate = moderatorOnly(ctx);
  if (!gate.ok) return gate;

  const ids = reports.flatMap((report) =>
    report.reporterPrincipalId === null ? [] : [report.reporterPrincipalId],
  );
  const rows = await ctx.ports.moderation.describeReporters(ids);
  return ok(new Map(rows.map((row) => [row.id, row.username])));
}

/** SPEC §61.1 — the queue, to a moderator and to nobody else. */
export async function listReports(
  ctx: ModerationContext,
  options: {
    /** One status, several, or none for all of them. The queue asks for two. */
    status?: ReportStatus | readonly ReportStatus[] | null;
    /** Null for every kind. §61.1 — "the accounts" and "the comments" are different jobs. */
    targetType?: ReportTarget["targetType"] | null;
    limit?: number;
    after?: string | null;
    /**
     * Which end of the queue (SPEC §61.1).
     *
     * `oldest` is the default and is the order a backlog is worked in. `newest` is the other
     * question a queue gets asked — "what has just come in" — which the oldest fifty cannot
     * answer on a queue of any depth, and which is the question somebody has whenever a
     * report has just been filed.
     */
    order?: "oldest" | "newest";
  } = {},
): Promise<Result<{ items: ReportRecord[]; nextCursor: string | null; total: number }>> {
  const gate = moderatorOnly(ctx);
  if (!gate.ok) return gate;

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const status =
    options.status === undefined || options.status === null
      ? null
      : typeof options.status === "string"
        ? [options.status]
        : options.status;
  const query = {
    status,
    targetType: options.targetType ?? null,
    order: options.order ?? ("oldest" as const),
  };

  const [items, total] = await Promise.all([
    ctx.ports.moderation.listReports({ ...query, limit: limit + 1, after: options.after ?? null }),
    // Only where a status was named. "How many reports are there in total" is not a question
    // any surface asks, and a count over the whole table is an index scan nobody wanted.
    status === null ? Promise.resolve(0) : ctx.ports.moderation.countReports(query),
  ]);
  const page = items.slice(0, limit);
  return ok({
    items: page,
    nextCursor: items.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    total,
  });
}

/**
 * What each entry in a page of the queue is about (SPEC §61.1).
 *
 * A second call rather than a wider `listReports`, because the REST surface returns the
 * report as a record and a subject line is not part of that record — it is what a page needs
 * to be usable. Gated like everything else here: the labels are titles of hidden articles and
 * the opening words of removed comments, which is exactly the material a report is about.
 */
export async function describeTargets(
  ctx: ModerationContext,
  reports: readonly ReportTarget[],
): Promise<Result<TargetSummary[]>> {
  const gate = moderatorOnly(ctx);
  if (!gate.ok) return gate;
  if (reports.length === 0) return ok([]);
  return ok(
    await ctx.ports.moderation.describeTargets(
      reports.map((report) => ({ targetType: report.targetType, targetId: report.targetId })),
    ),
  );
}

/** Claims a report for review, or closes it without acting (SPEC §61.1). */
export async function reviewReport(
  ctx: ModerationContext,
  input: ReviewInput,
): Promise<Result<{ id: string; status: ReportStatus }>> {
  const gate = moderatorOnly(ctx);
  if (!gate.ok) return gate;
  const actor = ctx.actor!;

  const report = await ctx.ports.moderation.findReport(input.reportId);
  if (report === null) return fail(ErrorType.NotFound, "Report not found");

  const now = ctx.ports.clock.now().toISOString();
  // Claiming moves open → reviewing; rejecting closes from either. Neither may reopen a
  // report that has already been actioned: the action is the record, and reversing it is
  // `restore`, not a status edit.
  const expected: ReportStatus[] = input.status === "reviewing" ? ["open"] : ["open", "reviewing"];

  const [moved] = await ctx.ports.db.commit([
    ctx.ports.moderation.setReportStatus(
      report.id,
      input.status,
      expected,
      actor.principalId as OratorId,
      input.resolution ?? null,
      now,
    ),
    journalAction(ctx, `report.${input.status}`, report.targetType, report.targetId, input.resolution ?? null, now),
  ]);

  if ((moved?.changes ?? 0) === 0) {
    return fail(
      ErrorType.Conflict,
      "That report has already been handled",
      `It is now ${report.status}. Re-read the queue before acting.`,
    );
  }
  return ok({ id: report.id, status: input.status });
}

/**
 * Applies a moderator's decision (SPEC §61.1, §61.2).
 *
 * One function for every action, because everything except the state change is identical
 * and must be: a record in `moderation_actions`, a record in `audit_log`, and a notification
 * to the author carrying the reason code. §61.2 makes all three mandatory, and three call
 * sites that each remembered two of them is how one gets forgotten.
 */
export async function applyModerationAction(
  ctx: ModerationContext,
  input: ActionInput,
): Promise<Result<{ id: OratorId; action: ModerationActionKind; targetId: string }>> {
  const gate = moderatorOnly(ctx);
  if (!gate.ok) return gate;
  const actor = ctx.actor!;

  const subject = await resolveTarget(ctx, input.targetType, input.targetId);
  if (subject === null) return fail(ErrorType.NotFound, "Nothing to act on at that identifier");

  const now = ctx.ports.clock.now().toISOString();
  const id = ctx.ports.ids.next();
  const source = input.source ?? (input.reportId ? "report" : "proactive");

  const effect = await stateChange(ctx, input, now);
  if (!effect.ok) return effect;

  const writes = [
    ...effect.value,
    ctx.ports.moderation.insertAction({
      id,
      targetType: input.targetType,
      targetId: input.targetId,
      action: input.action,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText ?? null,
      source,
      reportId: (input.reportId ?? null) as OratorId | null,
      actorPrincipalId: actor.principalId as OratorId,
      createdAt: now,
    }),
    // §61.2 — both journals, always. `moderation_actions` is the object's operational
    // history; `audit_log` is the security record of who did it, from where, with which
    // token. They answer different questions and neither substitutes for the other (§62).
    journalAction(ctx, `moderation.${input.action}`, input.targetType, input.targetId, input.reasonCode, now),
  ];

  /**
   * §61.2 — the author is told, with the reason code.
   *
   * A platform that removes somebody's work and does not say so is one they cannot appeal
   * to, and §61.1 requires an appeal process. The event is private to the author: what was
   * done to their article is not public activity.
   */
  if (subject.authorPrincipalId !== null) {
    writes.push(
      ctx.ports.events.insert({
        id: ctx.ports.ids.next(),
        type: "moderation.actioned",
        actorPrincipalId: actor.principalId as OratorId,
        subjectType: input.targetType,
        subjectId: input.targetId as OratorId,
        audiencePrincipalId: subject.authorPrincipalId as OratorId,
        visibility: "private",
        payload: {
          schema_version: SCHEMA_VERSION,
          action: input.action,
          reason_code: input.reasonCode,
          ...(input.reasonText ? { reason_text: input.reasonText } : {}),
        },
        createdAt: now,
      }),
    );
  }

  // Search, sitemap and cache all key off this. Removing an article and leaving it in the
  // index is the failure mode that makes a takedown look like it did not happen (§38.1).
  if (input.targetType === "article") {
    writes.push(
      ctx.ports.outbox.enqueue({
        id: ctx.ports.ids.next(),
        eventType: input.action === "restore" ? "article.updated" : "article.removed",
        aggregateType: "article",
        aggregateId: input.targetId,
        payload: { schema_version: SCHEMA_VERSION, moderation: input.action, reason_code: input.reasonCode },
        requestId: ctx.requestId,
        createdAt: now,
      }),
    );
  }

  if (input.reportId) {
    writes.push(
      ctx.ports.moderation.setReportStatus(
        input.reportId,
        "actioned",
        ["open", "reviewing"],
        actor.principalId as OratorId,
        `${input.action}: ${input.reasonCode}`,
        now,
      ),
    );
  }

  await ctx.ports.db.commit(writes);
  return ok({ id, action: input.action, targetId: input.targetId });
}

/**
 * What the platform has done lately (SPEC §61.1, §61.2).
 *
 * The other half of a review queue. A queue shows what has been asked of moderators; this
 * shows what they did, which is what makes an action reversible in practice — `restore`
 * exists in §61.1's verb list, and until there was a page listing what had been hidden there
 * was nothing to press it on.
 */
export async function recentActions(
  ctx: ModerationContext,
  options: { limit?: number; before?: string | null } = {},
): Promise<Result<{ items: ModerationActionRecord[]; nextCursor: string | null }>> {
  const gate = moderatorOnly(ctx);
  if (!gate.ok) return gate;

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const items = await ctx.ports.moderation.listRecentActions(limit + 1, options.before ?? null);
  const page = items.slice(0, limit);
  return ok({
    items: page,
    nextCursor: items.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  });
}

/**
 * One article, as a moderator needs to see it (SPEC §61.1).
 *
 * The state, not the paperwork. A lookup that answered with a list of past actions and a row
 * of buttons was answering the wrong question: the first thing to know about an article
 * somebody has written in about is whether it is currently published, listed, indexed or
 * gone — and none of that can be read off the log, because a log is a sequence of edits and
 * the state is where they landed.
 *
 * Reads the row directly rather than the public view: an article this is asked about is
 * frequently one that is hidden or removed, which the public view will not return at all.
 */
export interface ArticleState {
  id: string;
  title: string | null;
  status: string;
  visibility: string;
  indexable: boolean;
  duplicateOf: string | null;
  removalSource: string | null;
  moderationState: string;
  authorPrincipalId: string;
  publishedAt: string | null;
  updatedAt: string;
}

/**
 * An account as a moderator needs to see it (SPEC §61.1, §43.3).
 *
 * The queue's lookup took an id and looked it up as an article, which was right for the id a
 * moderator usually has and wrong for the one they have straight after suspending somebody:
 * a handle. Neither the handle nor the principal id resolved to anything, so the field
 * answered "nothing here" about an account that had just been acted on.
 *
 * Takes either, and tries the id first. The two cannot collide — §12.2 makes an id 26
 * uppercase Crockford characters and §7.3 canonicalises a username to lower case — so one
 * field can carry both without asking which was meant, which is the property that keeps a
 * lookup usable.
 *
 * No email, no token, no session. This answers "who is this and what has been done about
 * them", which is what §61.1 needs; the rest is §23's material and not a moderator's.
 */
export interface PrincipalState {
  id: string;
  username: string;
  displayName: string | null;
  kind: "human" | "agent";
  status: string;
  platformRole: string;
  trustLevel: number | null;
  systemAccount: boolean;
  ownerPrincipalId: string | null;
  createdAt: string;
}

export async function inspectPrincipal(
  ctx: ModerationContext,
  idOrUsername: string,
): Promise<Result<PrincipalState | null>> {
  const gate = moderatorOnly(ctx);
  if (!gate.ok) return gate;

  const asked = idOrUsername.trim().replace(/^@/, "");
  if (asked === "") return ok(null);

  const principal =
    (await ctx.ports.principals.findById(asked.toUpperCase())) ??
    (await ctx.ports.principals.findByUsername(asked.toLowerCase()));
  if (principal === null) return ok(null);

  return ok({
    id: principal.id,
    username: principal.username,
    displayName: principal.displayName,
    kind: principal.kind,
    status: principal.status,
    platformRole: principal.platformRole,
    trustLevel: principal.trustLevel ?? null,
    systemAccount: principal.systemAccount,
    ownerPrincipalId: principal.ownerPrincipalId ?? null,
    createdAt: principal.createdAt,
  });
}

export async function inspectArticle(
  ctx: ModerationContext,
  id: string,
): Promise<Result<ArticleState | null>> {
  const gate = moderatorOnly(ctx);
  if (!gate.ok) return gate;

  const article = await ctx.ports.articles.findById(id);
  if (article === null) return ok(null);

  const [described] = await ctx.ports.moderation.describeTargets([
    { targetType: "article", targetId: id },
  ]);
  return ok({
    id: article.id,
    title: described?.label ?? null,
    status: article.status,
    visibility: article.visibility,
    indexable: article.indexable,
    duplicateOf: article.duplicateOf ?? null,
    removalSource: article.removalSource,
    moderationState: article.moderationState,
    authorPrincipalId: article.authorPrincipalId,
    publishedAt: article.publishedAt,
    updatedAt: article.updatedAt,
  });
}

/**
 * The moderation history of one object, to a moderator (SPEC §61.2).
 *
 * Takes the narrow context rather than the whole of `Ports`: this is reached from the
 * moderation section as well as from the API, and §28's argument is that a surface should be
 * handed the smallest set it can do its work with. A full `RequestContext` still satisfies it.
 */
export async function listModerationActions(
  ctx: ModerationContext,
  targetType: string,
  targetId: string,
): Promise<Result<ModerationActionRecord[]>> {
  const gate = moderatorOnly(ctx);
  if (!gate.ok) return gate;
  return ok(await ctx.ports.moderation.listActions(targetType, targetId, 50));
}

// --- the parts the three above share ----------------------------------------

function moderatorOnly(ctx: ModerationContext): Result<true> {
  const actor = ctx.actor;
  if (actor === null) return fail(ErrorType.Unauthenticated, "Authentication required");
  const decision = canModerate(actor);
  if (!decision.allowed) {
    return fail(
      decision.reason === "insufficient-scope" ? ErrorType.InsufficientScope : ErrorType.Forbidden,
      "Not permitted",
      decision.reason === "requires-moderator"
        ? "This action requires a moderator or administrator."
        : "The token does not carry admin:moderate.",
    );
  }
  return ok(true);
}

const journalAction = (
  ctx: ModerationContext,
  action: string,
  targetType: string,
  targetId: string,
  reason: string | null,
  at: string,
) =>
  ctx.ports.audit.record({
    id: ctx.ports.ids.next(),
    actorPrincipalId: (ctx.actor?.principalId ?? null) as OratorId | null,
    actorTokenId: ctx.tokenId,
    action,
    targetType,
    targetId,
    outcome: "success",
    reason,
    ipHash: ctx.ipHash,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
    createdAt: at,
  });

/**
 * Who is notified, and enough state to decide what an action means for this target.
 *
 * Also what `createReport` checks a report against, for two questions that are one read: that
 * there is something at that identifier — without which the table accepts a report about any
 * string, and becomes a place to write arbitrary data from an unauthenticated endpoint — and
 * who answers for it, which decides whether the reporter is reporting themselves.
 */
interface Subject {
  authorPrincipalId: string | null;
  status: string;
}

async function resolveTarget(
  ctx: ModerationContext,
  targetType: ActionInput["targetType"],
  targetId: string,
): Promise<Subject | null> {
  switch (targetType) {
    case "article": {
      const article = await ctx.ports.articles.findById(targetId);
      return article === null ? null : { authorPrincipalId: article.authorPrincipalId, status: article.status };
    }
    case "comment": {
      const comment = await ctx.ports.social.findComment(targetId);
      return comment === null ? null : { authorPrincipalId: comment.authorPrincipalId, status: comment.status };
    }
    case "principal": {
      const principal = await ctx.ports.principals.findById(targetId);
      return principal === null ? null : { authorPrincipalId: principal.id, status: principal.status };
    }
    case "media": {
      const media = await ctx.ports.media.findById(targetId);
      return media === null ? null : { authorPrincipalId: media.ownerPrincipalId, status: media.status };
    }
  }
}

/**
 * What each action actually changes (SPEC §61.1).
 *
 * The mapping is deliberately narrow. `hide` takes something out of public view and is
 * reversible; `remove` is the tombstone of §23.2, which keeps the id resolving so citations
 * to it still answer; `unindex` leaves the article public and takes it out of search and the
 * sitemap (§50.3); `suspend` stops a principal acting; `warn` changes nothing and exists so
 * that a warning is on the record before an escalation is.
 */
async function stateChange(
  ctx: ModerationContext,
  input: ActionInput,
  now: string,
): Promise<Result<PendingWrite[]>> {
  const { targetType, targetId, action } = input;

  /*
   * The map decides, and the switch below only says how.
   *
   * Checked here so that `ACTIONS_FOR` is the single answer to "may this verb be used on
   * this target" rather than a second copy of the switch that a surface reads. A table and a
   * `switch` that must agree are a table and a `switch` that eventually do not.
   */
  if (!ACTIONS_FOR[targetType].includes(action)) {
    return fail(
      ErrorType.ValidationFailed,
      `${action} does not apply to a ${targetType}`,
      "Suspension applies to a principal; unindexing to an article; hide and remove to content.",
      { field: "action" },
    );
  }

  if (action === "warn") return ok([]);

  if (action === "restore") {
    const last = await ctx.ports.moderation.findLastAction(targetType, targetId);
    if (last === null || last.action === "warn" || last.action === "restore") {
      return fail(ErrorType.Conflict, "There is nothing to restore", "No unreversed action on that target.");
    }
    return ok([...(await undo(ctx, last, targetType, targetId, now)), ctx.ports.moderation.reverseAction(last.id, now)]);
  }

  switch (targetType) {
    case "article": {
      if (action === "unindex") return ok([ctx.ports.articles.updateMetadata(targetId, { indexable: false }, now)]);
      if (action === "hide") return ok([ctx.ports.articles.unpublish(targetId, now)]);
      if (action === "remove") {
        // §61.1 — a legal order answers 451 and an ordinary tombstone answers 410, and the
        // difference is stated to a reader rather than inferred from the reason text.
        const why = input.source === "legal" ? "legal" : "moderation";
        return ok([ctx.ports.articles.setStatus(targetId, "removed", now, why)]);
      }
      break;
    }
    case "comment": {
      if (action === "hide") return ok([ctx.ports.social.setCommentStatus(targetId, "hidden", now)]);
      if (action === "remove") return ok([ctx.ports.social.setCommentStatus(targetId, "removed", now)]);
      break;
    }
    case "principal": {
      if (action === "suspend") return ok([ctx.ports.principals.setStatus(targetId, "suspended", now)]);
      break;
    }
    case "media": {
      // `rejected` is the media record's only removal state (§21.1): the bytes stop being
      // served and the row survives so that a reference to them still resolves to a reason.
      if (action === "hide" || action === "remove") {
        return ok([ctx.ports.media.markRejected(targetId, now)]);
      }
      break;
    }
  }

  return fail(
    ErrorType.ValidationFailed,
    `${action} does not apply to a ${targetType}`,
    "Suspension applies to a principal; unindexing to an article; hide and remove to content.",
    { field: "action" },
  );
}

/** The inverse of an action, for `restore`. */
async function undo(
  ctx: ModerationContext,
  last: ModerationActionRecord,
  targetType: string,
  targetId: string,
  now: string,
): Promise<PendingWrite[]> {
  if (targetType === "article") {
    if (last.action === "unindex") return [ctx.ports.articles.updateMetadata(targetId, { indexable: true }, now)];
    // Back to `unpublished`, not to `published`. Restoring an article to public view is the
    // author's decision to make; a moderator's job here is to lift the sanction, and
    // republishing on their behalf would put words back under somebody's name without
    // asking them (§23.1).
    return [ctx.ports.articles.setStatus(targetId, "unpublished", now)];
  }
  if (targetType === "comment") return [ctx.ports.social.setCommentStatus(targetId, "visible", now)];
  if (targetType === "principal") return [ctx.ports.principals.setStatus(targetId, "active", now)];
  return [];
}

// ---------------------------------------------------------------------------
// Screening, after the fact (SPEC §61, §58.2)
// ---------------------------------------------------------------------------

/**
 * The provider slot (SPEC §61).
 *
 * `check(content, context) → { action, categories, score }`, as §61 specifies. A model, an
 * external service or a human queue can occupy it; the built-in heuristics are the floor,
 * because §61 forbids the mandatory path depending on infrastructure one deployment happens
 * to run (§66.6). A self-hosted model may be added beside this, never instead of it.
 */
export interface ModerationProvider {
  readonly name: string;
  check(
    content: { title: string; body: string },
    context: { authorKind: "human" | "agent"; trustLevel: number },
  ): Promise<ModerationVerdict>;
}

/**
 * The floor, plus something that reads (SPEC §61, §80.19).
 *
 * Two providers rather than a choice between them, because they see different things. The
 * heuristic finds what is mechanically visible — hidden text, a forged boundary, link
 * farming — which a model notices unreliably if at all. A model tells spam and abuse from an
 * argument somebody dislikes, which no rule can. Neither is a superset of the other, so
 * running one would be choosing which half of §61 to implement.
 *
 * **What happens when the reader is unavailable is the whole design.** If the floor found
 * something, its flag stands: a report raised is strictly better than a report withheld, and
 * flagged content is not indexable either way. If the floor found nothing, the failure
 * propagates and the article is left `unchecked` — because "the rules matched nothing" is not
 * "somebody looked for abuse", and collapsing those two is exactly how an outage at a
 * provider becomes a clean bill of health for everything published during it.
 */
export function withFloor(floor: ModerationProvider, reader: ModerationProvider): ModerationProvider {
  return {
    name: `${floor.name}+${reader.name}`,
    async check(content, context) {
      const below = await floor.check(content, context);

      let above: ModerationVerdict;
      try {
        above = await reader.check(content, context);
      } catch (error) {
        if (below.action === "flag") return below;
        throw error;
      }

      return {
        action: below.action === "flag" || above.action === "flag" ? "flag" : "allow",
        // Union, and the floor's codes first: a moderator reading the queue wants the
        // mechanical finding — which is checkable — before the model's judgement, which is not.
        categories: [...new Set([...below.categories, ...above.categories])],
        // The higher of the two. A queue read worst-first should not be reordered by the
        // provider that happened to be less alarmed.
        score: Math.max(below.score, above.score),
        provider: `${below.provider}+${above.provider}`,
      };
    },
  };
}

/** The provider that needs nothing to work, and therefore always does. */
export const heuristicProvider: ModerationProvider = {
  name: HEURISTIC_PROVIDER,
  async check(content) {
    return screen(content);
  },
};

/**
 * Screens one published article and records what was found (SPEC §61).
 *
 * Runs from the queue, after publishing, never before it. §61 makes that a MUST and the
 * reason is not latency: a moderation gate on the write path means an outage at a provider
 * stops the platform accepting work, and a false positive silently refuses to publish
 * somebody's article. Here a verdict changes what the article is *eligible* for (§50.3) and
 * puts a row in a queue a person reads.
 *
 * Idempotent, because the queue delivers at least once: it reads the article's current
 * state, and re-running it produces the same verdict and the same single automatic report.
 */
export async function screenArticle(
  ports: Ports,
  articleId: string,
  provider: ModerationProvider = heuristicProvider,
): Promise<"passed" | "flagged" | "unchecked" | "skipped"> {
  const article = await ports.articles.findById(articleId);
  if (article === null || article.status !== "published") return "skipped";
  if (article.publishedRevisionId === null) return "skipped";

  const revision = await ports.articles.findRevision(article.publishedRevisionId);
  if (revision === null) return "skipped";

  const body = await ports.content.get(revision.contentHash);
  if (body === null) return "skipped";

  const author = await ports.principals.findById(article.authorPrincipalId);
  const now = ports.clock.now().toISOString();

  let verdict: ModerationVerdict;
  try {
    verdict = await provider.check(
      { title: revision.title, body },
      { authorKind: author?.kind ?? "agent", trustLevel: author?.trustLevel ?? 0 },
    );
  } catch (error) {
    /*
     * §61 — an unavailable provider leaves the content `unchecked`, and unchecked content
     * does not become indexable (§50.3).
     *
     * Not `passed`. The difference between "nobody looked" and "somebody looked and found
     * nothing" is the whole reason the column has three states, and collapsing them would
     * make an outage at a provider look like a clean bill of health for everything
     * published during it.
     */
    console.error(
      JSON.stringify({
        level: "error",
        event: "moderation.provider.unavailable",
        provider: provider.name,
        article_id: articleId,
        error: String(error),
      }),
    );
    return "unchecked";
  }

  const state = verdict.action === "flag" ? "flagged" : "passed";
  const writes = [
    ports.articles.setModerationState(articleId, state, JSON.stringify(verdict), now),
  ];

  /*
   * A flag raises a report rather than acting on the article.
   *
   * §58.2 item 6 is explicit that scanning for injection signatures is a moderation signal
   * and not a block on publishing, and §60.1 says the same of duplicate detection. What a
   * rule-based provider is good for is putting the right thing in front of a person; what
   * it is not good for is deciding. The report carries the categories so the queue can be
   * read worst-first.
   */
  if (state === "flagged") {
    const existing = await ports.moderation.countRecentReports("article", articleId, "");
    if (existing === 0) {
      writes.push(
        ports.moderation.insertReport({
          id: ports.ids.next(),
          targetType: "article",
          targetId: articleId as OratorId,
          // Automatic: no principal reported this, and recording one would put a person's
          // name on a machine's judgement.
          reporterPrincipalId: null,
          reporterContact: null,
          category: verdict.categories.includes("prompt_injection") ? "injection" : "spam",
          details: `${provider.name} scored ${verdict.score.toFixed(2)}: ${verdict.categories.join(", ")}`,
          createdAt: now,
        }),
      );
    }
  }

  await ports.db.commit(writes);
  return state;
}

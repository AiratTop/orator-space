import { ErrorType, SCHEMA_VERSION, type OratorId } from "@orator/protocol";
import type { ReportCategory } from "../ports/index.js";
import { fail, ok, type RequestContext, type Result } from "./context.js";

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
  ctx: RequestContext,
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

  const exists = await targetExists(ctx, input.targetType, input.targetId);
  if (!exists) return fail(ErrorType.NotFound, "Nothing to report at that identifier");

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
      reporterPrincipalId: (ctx.actor?.principalId ?? null) as OratorId | null,
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
 * Checked before the row is written.
 *
 * Without it the table accepts a report about any string at all, which makes it a place to
 * write arbitrary data into the database from an unauthenticated endpoint.
 */
async function targetExists(
  ctx: RequestContext,
  targetType: CreateReportInput["targetType"],
  targetId: string,
): Promise<boolean> {
  switch (targetType) {
    case "article":
      return (await ctx.ports.articles.findById(targetId)) !== null;
    case "comment":
      return (await ctx.ports.social.findComment(targetId)) !== null;
    case "principal":
      return (await ctx.ports.principals.findById(targetId)) !== null;
    case "media":
      // Media arrives later in this phase; until then there is nothing to point at.
      return false;
  }
}

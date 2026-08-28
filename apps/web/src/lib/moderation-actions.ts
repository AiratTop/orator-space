import {
  applyModerationAction,
  REASON_CODES,
  reviewReport,
  type ModerationContext,
  type ReasonCode,
  type ServiceError,
} from "@orator/core";
import type { ActionOutcome } from "./settings-actions.js";

/**
 * What a moderator may do from the queue page (SPEC §61.1).
 *
 * A separate dispatcher from `/settings`'s own, because it acts in a different context: the
 * account actions run as the reader on their own things, and these run as a moderator on
 * somebody else's. Keeping them apart means the wider authority is reached through a
 * different door rather than through a longer switch statement.
 *
 * The verbs are §61.1's and nothing beyond them. `remove` tombstones (§23.2) and does not
 * erase — erasure is §23.3, needs a confirmation the platform asks for explicitly, and is
 * not something to put one click away in a queue somebody is working through quickly.
 */
const KINDS = ["hide", "remove", "unindex", "suspend", "restore", "warn"] as const;
type Kind = (typeof KINDS)[number];
const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);

const TARGETS = ["article", "comment", "principal", "media"] as const;
type Target = (typeof TARGETS)[number];
const isTarget = (value: string): value is Target => (TARGETS as readonly string[]).includes(value);

const isReason = (value: string): value is ReasonCode =>
  (REASON_CODES as readonly string[]).includes(value);

const problem = (error: ServiceError): ActionOutcome => ({
  kind: "failed",
  message: error.title,
  ...(error.detail === undefined ? {} : { detail: error.detail }),
});

const text = (form: FormData, field: string): string => {
  const value = form.get(field);
  return typeof value === "string" ? value.trim() : "";
};

/** Whether this form is one of ours, so the page knows which dispatcher to call. */
export const isModerationAction = (action: string): boolean => action.startsWith("moderation.");

export async function performModeration(
  ctx: ModerationContext,
  form: FormData,
): Promise<ActionOutcome> {
  switch (text(form, "action")) {
    case "moderation.act": {
      const kind = text(form, "kind");
      const targetType = text(form, "target-type");
      const reason = text(form, "reason");
      if (!isKind(kind)) return { kind: "failed", message: "Unknown action" };
      if (!isTarget(targetType)) return { kind: "failed", message: "Unknown target" };
      if (!isReason(reason)) return { kind: "failed", message: "Unknown reason code" };

      /*
       * §61.2 — the source is what actually happened, not where the form was.
       *
       * With a report it is `report` and the report is closed by the same action. Without one
       * this is a moderator who found something themselves, which §61.2 calls `proactive` —
       * and the distinction is the whole value of the log: "acted on a complaint" and "went
       * looking" are different facts about how a platform is run.
       */
      const reportId = text(form, "report");
      const result = await applyModerationAction(ctx, {
        targetType,
        targetId: text(form, "target"),
        action: kind,
        reasonCode: reason,
        source: reportId === "" ? "proactive" : "report",
        ...(reportId === "" ? {} : { reportId }),
      });
      return result.ok
        ? { kind: "done", message: `${kind} applied. The author is told, and it is reversible.` }
        : problem(result.error);
    }

    case "moderation.reject": {
      const result = await reviewReport(ctx, {
        reportId: text(form, "report"),
        status: "rejected",
        // Kept short and stored: §61.2 wants the resolution recorded, not the click.
        resolution: text(form, "resolution") || "No action needed.",
      });
      return result.ok
        ? { kind: "done", message: "Report closed with no action." }
        : problem(result.error);
    }

    default:
      return { kind: "failed", message: "Unknown action" };
  }
}

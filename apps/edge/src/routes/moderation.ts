import { Hono } from "hono";
import {
  applyModerationAction,
  listReports,
  reviewReport,
  withIdempotency,
  type ReportRecord,
} from "@orator/core";
import { schemas } from "@orator/protocol";
import { parse, problemResponse, requireIdempotencyKey, respond } from "../http.js";
import type { Env } from "../index.js";

/**
 * The moderation queue and the actions taken from it (SPEC §61.1).
 *
 * Its own file, and its own path prefix, because everything here is gated on a role rather
 * than on ownership. Mixing a moderator's endpoints in with an author's is how a scope check
 * ends up being the only thing between the two, and §43.3 wants the separation visible.
 *
 * Report *intake* is deliberately not here: it lives with the articles it is about, is
 * usable without an account, and shares nothing with this file but a table (§61.2).
 */
export const moderationRoutes = new Hono<{ Bindings: Env; Variables: { ctx: never } }>();

/** The reporter is named to a moderator and to nobody else (§61.2). */
const reportView = (report: ReportRecord) => ({
  id: report.id,
  target_type: report.targetType,
  target_id: report.targetId,
  category: report.category,
  details: report.details,
  status: report.status,
  resolution: report.resolution,
  reporter_principal_id: report.reporterPrincipalId,
  reporter_contact: report.reporterContact,
  reviewed_by: report.reviewedBy,
  created_at: report.createdAt,
  reviewed_at: report.reviewedAt,
});

moderationRoutes.get("/v1/moderation/reports", async (c) => {
  const ctx = c.get("ctx");
  const status = c.req.query("status");
  const result = await listReports(ctx, {
    status: (status ?? null) as never,
    limit: Number(c.req.query("limit") ?? 50),
    after: c.req.query("after") ?? null,
  });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  return respond(c, {
    ok: true,
    value: { items: result.value.items.map(reportView), next_cursor: result.value.nextCursor },
  });
});

moderationRoutes.post("/v1/moderation/reports/:id/review", async (c) => {
  const parsed = parse(c, schemas.reviewReportRequest, await c.req.json().catch(() => null));
  if ("response" in parsed) return parsed.response;

  const result = await reviewReport(c.get("ctx"), {
    reportId: c.req.param("id"),
    status: parsed.data.status,
    resolution: parsed.data.resolution ?? null,
  });
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);
  return respond(c, { ok: true, value: { id: result.value.id, status: result.value.status } });
});

/**
 * §34.1 — an idempotency key is required, as it is for every other write that is not
 * naturally idempotent.
 *
 * Suspending a principal twice is harmless; removing an article twice is harmless; but each
 * one writes a row to `moderation_actions` and notifies the author again, and a moderator
 * whose request timed out should not have to decide whether to risk a second notification
 * telling somebody their work was removed.
 */
moderationRoutes.post("/v1/moderation/actions", async (c) => {
  const idem = requireIdempotencyKey(c);
  if ("response" in idem) return idem.response;

  const body = await c.req.json().catch(() => null);
  const parsed = parse(c, schemas.moderationActionRequest, body);
  if ("response" in parsed) return parsed.response;

  const ctx = c.get("ctx");
  const result = await withIdempotency(ctx, idem.key, "POST /v1/moderation/actions", body, () =>
    applyModerationAction(ctx, {
      targetType: parsed.data.target_type,
      targetId: parsed.data.target_id,
      action: parsed.data.action,
      reasonCode: parsed.data.reason_code,
      reasonText: parsed.data.reason_text ?? null,
      ...(parsed.data.source === undefined ? {} : { source: parsed.data.source }),
      reportId: parsed.data.report_id ?? null,
    }),
  );
  if (!result.ok) return problemResponse(c, result.error, new URL(c.req.url).pathname);

  return respond(
    c,
    { ok: true, value: { id: result.value.id, action: result.value.action, target_id: result.value.targetId } },
    201,
  );
});

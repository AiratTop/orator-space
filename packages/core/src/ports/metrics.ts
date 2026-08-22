import type { AudienceClass } from "../observability/audience.js";

/**
 * What is measured, and where it goes (SPEC §66.2).
 *
 * §66.2 forbids writing metrics to D1 and spends a paragraph on why: displaying "43 agents
 * read it" the naive way turns the most frequent operation in a read-heavy system into a
 * write, conflicts with edge caching — a cached response never reaches the Worker, so the
 * counter does not move — and spends the database size limit on data that is not a source
 * of truth.
 *
 * So a metric is a fire-and-forget write to Analytics Engine, and `article_stats` is filled
 * from it on a schedule. Nothing here is allowed to fail a request.
 */

/** SPEC §66.2, §83 — the events worth a data point. */
export type MetricName =
  | "article.read"
  | "article.published"
  | "comment.created"
  | "edge.created"
  | "search.query"
  | "mcp.tool"
  | "api.request";

export interface MetricEvent {
  name: MetricName;
  /** SPEC §66.5 — mandatory on every metric, without exception. */
  audience: AudienceClass;
  /** The article, principal or tool the event is about. High cardinality is the point. */
  subject?: string | null;
  /** An outcome, a tool name, a status class — whatever the name makes meaningful. */
  detail?: string | null;
  /** Milliseconds, when the event has a duration worth an SLI (§66.4). */
  durationMs?: number | null;
}

/**
 * The port.
 *
 * `write` returns nothing and must never throw: a metric that could fail a request would
 * make observability an availability risk, which is the opposite of the point. The adapter
 * swallows and logs.
 */
export interface Metrics {
  write(event: MetricEvent): void;
}

/** For tests and for the surfaces that have no binding: counts nothing, breaks nothing. */
export const noMetrics: Metrics = { write: () => undefined };

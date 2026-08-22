import type { MetricEvent, Metrics } from "@orator/core";

/**
 * Analytics Engine (SPEC §66.2).
 *
 * The shape is fixed by the product rather than by the binding: `blobs` is an ordered array
 * with no names, so the order below *is* the schema, and a query written against it breaks
 * silently if a field is inserted rather than appended. New dimensions go on the end.
 *
 *   blob1  metric name
 *   blob2  audience_class          — §66.5, mandatory on every metric
 *   blob3  subject                 — article id, principal id, tool name
 *   blob4  detail                  — outcome, status class, whatever the name makes mean
 *   double1  duration in ms        — 0 when the event has no duration
 *
 * `index1` is the audience class. Analytics Engine samples by index under load, so putting
 * the dimension §3.1 depends on there keeps the machine traffic distinguishable exactly when
 * there is enough of it to matter.
 */
export function createMetrics(dataset: AnalyticsEngineDataset | undefined): Metrics {
  if (dataset === undefined) {
    // Not an error. §64.2 runs `wrangler dev` without the binding, and a local run that
    // refused to start because nothing was counting would be a worse trade than silence.
    return { write: () => undefined };
  }

  return {
    write(event: MetricEvent): void {
      try {
        dataset.writeDataPoint({
          blobs: [event.name, event.audience, event.subject ?? "", event.detail ?? ""],
          doubles: [event.durationMs ?? 0],
          indexes: [event.audience],
        });
      } catch (error) {
        /*
         * Swallowed, and that is the contract (§66.2).
         *
         * A metric that could fail a request would make observability an availability risk,
         * which is the opposite of what it is for. The log line is the fallback: if the
         * dataset is misconfigured, that shows up in the logs rather than in a 500 handed to
         * somebody trying to read an article.
         */
        console.error(JSON.stringify({ level: "warn", event: "metrics.write.failed", error: String(error) }));
      }
    },
  };
}

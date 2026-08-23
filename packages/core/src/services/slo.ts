import type { MetricsQuery, SloRepo } from "../ports/slo.js";

/**
 * The §66.4 indicators, evaluated (SPEC §66.4, §66.7).
 *
 * §66.4 lists seven and calls them mandatory from day one. None of them is visible to an
 * external prober — Gatus can tell whether an endpoint answers and nothing about whether the
 * outbox is draining — so the platform reports on itself here, and a monitor that already
 * exists turns that report into an alert by reading its status code.
 *
 * That is the whole design decision: an alerting backend (§66.6, §80.15) is a system to run,
 * and the thing it would do first is exactly this evaluation. Doing it in the Worker, against
 * numbers the Worker can already read, closes six of the seven rows without one.
 *
 * **Unavailable is not healthy, and not an alert either.** Two indicators need Analytics
 * Engine and one needs a purge implementation that does not exist. Reporting those as `ok`
 * would be a lie that alerts nobody; reporting them as breached would ring a bell nobody can
 * silence. They report what they are, and the summary counts them separately.
 */

export type IndicatorState = "ok" | "warning" | "breached" | "unavailable" | "not-implemented";

export interface Indicator {
  /** Stable, machine-readable, and the name §66.4 uses. */
  name: string;
  state: IndicatorState;
  /** What was measured. Null when nothing could be. */
  value: number | null;
  unit: "ms" | "seconds" | "count" | "fraction" | "bytes";
  /** The threshold §66.4 sets, so a report explains itself without the specification. */
  threshold: string;
  detail?: string;
}

export interface SloReport {
  /** `breached` when any indicator is; `degraded` when one is only unavailable or warning. */
  status: "ok" | "degraded" | "breached";
  indicators: Indicator[];
  measuredAt: string;
}

/**
 * SPEC §66.4's table, as numbers.
 *
 * Here rather than inline so that the thresholds are one list an operator can read, and so
 * that a test can assert the boundary rather than the shape of an if-statement.
 */
export const THRESHOLDS = {
  publishP95Ms: 400,
  serverErrorRate: 0.005,
  errorWindowMinutes: 5,
  outboxDepth: 100,
  outboxAgeSeconds: 300,
  indexingP95Seconds: 60,
  /** How far back a dead letter still counts as news. */
  deadLetterWindowMinutes: 60,
  /** §31.3 — D1's ceiling, and §66.4's two marks on the way to it. */
  databaseLimitBytes: 10 * 1024 * 1024 * 1024,
  databaseWarnFraction: 0.6,
  databaseBreachFraction: 0.8,
} as const;

/** How many recently indexed articles the lag percentile is taken over. */
export const INDEXING_SAMPLE = 50;

export interface SloPorts {
  slo: SloRepo;
  metrics: MetricsQuery;
  clock: { now(): Date };
}

export async function evaluateSlo(ports: SloPorts): Promise<SloReport> {
  const now = ports.clock.now();
  const since = new Date(now.getTime() - THRESHOLDS.deadLetterWindowMinutes * 60_000).toISOString();

  /*
   * Read in parallel, because the report is a snapshot rather than a sequence.
   *
   * They are independent queries against two systems, and a metrics backend that is slow
   * must not add its latency to a database read an operator is waiting on.
   */
  const [backlog, lag, deadLetters, bytes, publishP95, errorRate] = await Promise.all([
    ports.slo.outboxBacklog(),
    ports.slo.indexingLag(INDEXING_SAMPLE),
    ports.slo.deadLettered(since),
    ports.slo.databaseBytes(),
    ports.metrics.publishLatencyP95Ms(THRESHOLDS.errorWindowMinutes),
    ports.metrics.serverErrorRate(THRESHOLDS.errorWindowMinutes),
  ]);

  const indicators: Indicator[] = [
    threshold("publish_p95", publishP95, "ms", `> ${THRESHOLDS.publishP95Ms} ms`, THRESHOLDS.publishP95Ms),
    threshold(
      "server_error_rate",
      errorRate,
      "fraction",
      `> ${THRESHOLDS.serverErrorRate * 100}% over ${THRESHOLDS.errorWindowMinutes} minutes`,
      THRESHOLDS.serverErrorRate,
    ),
    outboxIndicator(backlog, now),
    threshold(
      "indexing_p95",
      lag.p95Seconds,
      "seconds",
      `p95 > ${THRESHOLDS.indexingP95Seconds} s`,
      THRESHOLDS.indexingP95Seconds,
      // No sample is not an outage. A quiet hour publishes nothing, and a percentile over
      // nothing is not a number — it is the absence of one.
      lag.sampled === 0 ? "nothing published recently enough to measure" : `over ${lag.sampled} articles`,
    ),
    {
      name: "dead_lettered",
      // §66.4 — anything at all. A message reaches the dead-letter queue after five failed
      // attempts, so one is already a handler that cannot succeed rather than a blip.
      state: deadLetters > 0 ? "breached" : "ok",
      value: deadLetters,
      unit: "count",
      threshold: `any, within ${THRESHOLDS.deadLetterWindowMinutes} minutes`,
    },
    databaseIndicator(bytes),
    {
      /*
       * §33.4 asks for a purge by URL on publish, and there is none to measure.
       *
       * Reported rather than omitted. §33.1 puts correctness in revalidation and not in
       * purging — a 60-second `s-maxage` bounds the staleness either way — so the absence is
       * a deliberate gap rather than a bug, and an indicator that quietly disappeared would
       * make it look closed.
       */
      name: "purge_failure_rate",
      state: "not-implemented",
      value: null,
      unit: "fraction",
      threshold: `> 10%`,
      detail: "no purge on publish (§33.4); correctness comes from revalidation (§33.1)",
    },
  ];

  return { status: summarise(indicators), indicators, measuredAt: now.toISOString() };
}

/** Above the threshold is breached; unavailable is neither. */
function threshold(
  name: string,
  value: number | null,
  unit: Indicator["unit"],
  stated: string,
  limit: number,
  detail?: string,
): Indicator {
  const base = { name, value, unit, threshold: stated };
  if (value === null) {
    return {
      ...base,
      state: "unavailable",
      detail: detail ?? "no metrics backend configured (§80.15)",
    };
  }
  return { ...base, state: value > limit ? "breached" : "ok", ...(detail === undefined ? {} : { detail }) };
}

/**
 * The backlog, which §66.4 measures two ways.
 *
 * Depth alone misses the failure that matters most: a single message retrying forever is a
 * depth of one and a pipeline that has stopped for that aggregate. Age catches it.
 */
function outboxIndicator(backlog: { pending: number; oldestPendingAt: string | null }, now: Date): Indicator {
  const ageSeconds =
    backlog.oldestPendingAt === null
      ? 0
      : Math.max(0, (now.getTime() - Date.parse(backlog.oldestPendingAt)) / 1000);

  const breached =
    backlog.pending > THRESHOLDS.outboxDepth || ageSeconds > THRESHOLDS.outboxAgeSeconds;

  return {
    name: "outbox_pending",
    state: breached ? "breached" : "ok",
    value: backlog.pending,
    unit: "count",
    threshold: `> ${THRESHOLDS.outboxDepth}, or oldest older than ${THRESHOLDS.outboxAgeSeconds / 60} minutes`,
    detail: `oldest ${Math.round(ageSeconds)} s`,
  };
}

function databaseIndicator(bytes: number | null): Indicator {
  const stated = `> ${THRESHOLDS.databaseWarnFraction * 100}% / > ${THRESHOLDS.databaseBreachFraction * 100}% of ${THRESHOLDS.databaseLimitBytes / 1024 ** 3} GB`;
  if (bytes === null) {
    return {
      name: "database_bytes",
      state: "unavailable",
      value: null,
      unit: "bytes",
      threshold: stated,
      detail: "the platform did not report a size",
    };
  }

  const used = bytes / THRESHOLDS.databaseLimitBytes;
  return {
    name: "database_bytes",
    state:
      used > THRESHOLDS.databaseBreachFraction
        ? "breached"
        : used > THRESHOLDS.databaseWarnFraction
          ? "warning"
          : "ok",
    value: bytes,
    unit: "bytes",
    threshold: stated,
    detail: `${(used * 100).toFixed(1)}% of the limit`,
  };
}

/**
 * One status for a monitor to read.
 *
 * `breached` is what an operator is woken for. `degraded` covers an indicator that could not
 * be measured or is on its way to a limit — worth seeing on a dashboard, not worth a page at
 * three in the morning, and the endpoint's status code reflects that distinction.
 *
 * `not-implemented` degrades nothing. It is a deliberate, documented absence rather than a
 * measurement that failed, and a status that can never read `ok` is a status nobody reads.
 */
function summarise(indicators: readonly Indicator[]): SloReport["status"] {
  if (indicators.some((i) => i.state === "breached")) return "breached";
  if (indicators.some((i) => i.state === "warning" || i.state === "unavailable")) return "degraded";
  return "ok";
}

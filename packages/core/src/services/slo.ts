import type { MetricSample, MetricsQuery, SloRepo } from "../ports/slo.js";

/**
 * The §66.4 indicators, evaluated (SPEC §66.4, §66.7).
 *
 * §66.4 lists them and calls them mandatory from day one. None of them is visible to an
 * external prober — Gatus can tell whether an endpoint answers and nothing about whether the
 * outbox is draining — so the platform reports on itself here, and a monitor that already
 * exists turns that report into an alert by reading its status code.
 *
 * That is the whole design decision: an alerting backend (§66.6, §80.15) is a system to run,
 * and the thing it would do first is exactly this evaluation. Doing it in the Worker, against
 * numbers the Worker can already read, closes all but two of its rows without one.
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
  /**
   * How far back a dead letter still counts as news.
   *
   * A day, not an hour. The alert clears on its own — there is no acknowledgement to record
   * and adding one would be a workflow for an event that should happen approximately never
   * — so the window is how long an operator has to notice. An hour is long enough to send a
   * notification and short enough that the dashboard is green again before anybody who was
   * asleep looks at it. Retention still bounds the table at thirty days (§23.4).
   */
  deadLetterWindowMinutes: 24 * 60,
  /**
   * How long the embedding sweep may be silent before it counts as stopped.
   *
   * Three missed runs of a five-minute cron. The number is about the schedule and not about
   * the corpus, deliberately: the sweep reads a window per run, so how long a full lap takes
   * grows with the corpus and how often it runs does not. A threshold derived from the corpus
   * size would need the count this whole change was made to stop taking.
   */
  sweepIdleMinutes: 15,
  /** §31.3 — D1's ceiling, and §66.4's two marks on the way to it. */
  databaseLimitBytes: 10 * 1024 * 1024 * 1024,
  databaseWarnFraction: 0.6,
  databaseBreachFraction: 0.8,
} as const;

/** How many recently indexed articles the lag percentile is taken over. */
export const INDEXING_SAMPLE = 50;

/** The sweep §66.4 watches, keyed as `drainEmbeddingBacklog` writes it. */
export const EMBEDDING_SWEEP_HANDLER = "embedding";

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
  const [backlog, sweep, lag, deadLetters, bytes, publishP95, errorRate] = await Promise.all([
    ports.slo.outboxBacklog(),
    ports.slo.sweepLastRun(EMBEDDING_SWEEP_HANDLER),
    ports.slo.indexingLag(INDEXING_SAMPLE),
    ports.slo.deadLettered(since),
    ports.slo.databaseBytes(),
    ports.metrics.publishLatencyP95Ms(THRESHOLDS.errorWindowMinutes),
    ports.metrics.serverErrorRate(THRESHOLDS.errorWindowMinutes),
  ]);

  const indicators: Indicator[] = [
    fromSample("publish_p95", publishP95, "ms", `> ${THRESHOLDS.publishP95Ms} ms`, THRESHOLDS.publishP95Ms),
    fromSample(
      "server_error_rate",
      errorRate,
      "fraction",
      `> ${THRESHOLDS.serverErrorRate * 100}% over ${THRESHOLDS.errorWindowMinutes} minutes`,
      THRESHOLDS.serverErrorRate,
    ),
    outboxIndicator(backlog, now),
    sweepIndicator(sweep, now),
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
      threshold: `any, within ${THRESHOLDS.deadLetterWindowMinutes / 60} hours`,
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
    return { ...base, state: "unavailable", ...(detail === undefined ? {} : { detail }) };
  }
  return { ...base, state: value > limit ? "breached" : "ok", ...(detail === undefined ? {} : { detail }) };
}

/**
 * Why a metric has no value, in words an operator can act on (§66.4).
 *
 * The distinction earns its place: somebody who has just set two secrets and is told "no
 * metrics backend configured" will go and check the secrets, which are fine. Each of these
 * points at a different next step.
 */
const WHY: Record<NonNullable<MetricSample["unavailable"]>, string> = {
  unconfigured: "no metrics backend configured — set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN (§80.15)",
  "query-failed": "the metrics query did not answer; the Worker's logs carry the status",
  "no-traffic": "nothing in the window to measure",
};

const fromSample = (
  name: string,
  sample: MetricSample,
  unit: Indicator["unit"],
  stated: string,
  limit: number,
): Indicator =>
  threshold(
    name,
    sample.value,
    unit,
    stated,
    limit,
    sample.value === null && sample.unavailable !== undefined ? WHY[sample.unavailable] : undefined,
  );

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

/**
 * Whether the embedding sweep is still going round (SPEC §66.4, §38.2).
 *
 * The indicator the sweep itself made necessary. The drain used to ask "what has no current
 * vector" every five minutes, which re-established the answer continuously and read the whole
 * corpus to do it; it now reads a window and remembers its place. That trade has one exposed
 * edge: a sweep that has stopped and a sweep with nothing to do are both silent, and the
 * difference is every article published after the moment it stopped, missing from semantic
 * search, indefinitely.
 *
 * Time since the last run, and not how far it has got. Position is not comparable between two
 * deployments or two corpus sizes, while "it ran in the last quarter of an hour" is the same
 * sentence everywhere. It is also one row read by primary key, which is what lets §66.4 poll
 * it as often as it likes.
 *
 * Never run is `unavailable` rather than breached. A deployment with no vector store never
 * starts the sweep (`semanticFor` returns nothing), and §38.2 makes that a documented
 * degradation to lexical search — an alert nobody can clear by fixing anything.
 */
function sweepIndicator(sweep: { position: string; at: string } | null, now: Date): Indicator {
  const stated = `silent for more than ${THRESHOLDS.sweepIdleMinutes} minutes`;
  if (sweep === null) {
    return {
      name: "embedding_sweep",
      state: "unavailable",
      value: null,
      unit: "seconds",
      threshold: stated,
      detail: "the sweep has not run on this deployment",
    };
  }

  const idleSeconds = Math.max(0, (now.getTime() - Date.parse(sweep.at)) / 1000);
  return {
    name: "embedding_sweep",
    state: idleSeconds > THRESHOLDS.sweepIdleMinutes * 60 ? "breached" : "ok",
    value: Math.round(idleSeconds),
    unit: "seconds",
    threshold: stated,
    detail: sweep.position === "" ? "at the start of a lap" : `at ${sweep.position}`,
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

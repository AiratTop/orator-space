/**
 * The observation, which is the only reason any of this is worth publishing (SPEC §3.1).
 *
 * §55.1 puts a source of observation at the top of the agent's cycle, before the model is
 * asked for anything, and §3.1 says why: text a model produced out of its training data has
 * near-zero value to a reading model, because the reader can produce the same thing itself,
 * more cheaply, without inheriting the writer's errors. A network of agents summarising each
 * other's summaries looks alive and contains nothing.
 *
 * So this module measures something. It is deliberately the least clever file here — the
 * point is that a real number enters the pipeline before a model sees it, not that the
 * measurement is sophisticated. Replace it with whatever your agent actually watches: a
 * benchmark, a monitoring endpoint, a dataset diff, a build that got slower.
 */

/**
 * Times a target over several samples and reports the distribution.
 *
 * Percentiles rather than a mean, because a mean over network latency describes nothing
 * anybody experiences. The first sample is kept and labelled rather than discarded: for a
 * cold path it is often the number that matters.
 */
export async function measure(target, { samples = 12, timeoutMs = 10_000 } = {}) {
  const durations = [];
  const failures = [];

  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
      await response.arrayBuffer();
      const elapsed = performance.now() - started;
      if (response.ok) durations.push(elapsed);
      else failures.push(`${response.status}`);
    } catch (error) {
      failures.push(error.name === "TimeoutError" ? "timeout" : error.message.slice(0, 60));
    }
  }

  durations.sort((a, b) => a - b);
  const at = (q) => (durations.length === 0 ? null : Math.round(durations[Math.min(durations.length - 1, Math.floor(q * durations.length))]));

  return {
    target,
    observed_at: new Date().toISOString(),
    samples,
    ok: durations.length,
    failed: failures.length,
    first_ms: durations.length === 0 ? null : Math.round(durations[0]),
    p50_ms: at(0.5),
    p90_ms: at(0.9),
    max_ms: durations.length === 0 ? null : Math.round(durations[durations.length - 1]),
    failures: [...new Set(failures)],
  };
}

/** The observation as a table, which is the part a reader actually uses. */
export function asTable(observation) {
  return [
    "| measurement | value |",
    "|---|---|",
    `| target | \`${observation.target}\` |`,
    `| observed at | ${observation.observed_at} |`,
    `| samples | ${observation.samples} (${observation.ok} succeeded, ${observation.failed} failed) |`,
    `| first request | ${observation.first_ms ?? "—"} ms |`,
    `| p50 | ${observation.p50_ms ?? "—"} ms |`,
    `| p90 | ${observation.p90_ms ?? "—"} ms |`,
    `| slowest | ${observation.max_ms ?? "—"} ms |`,
    ...(observation.failures.length === 0 ? [] : [`| failures | ${observation.failures.join(", ")} |`]),
  ].join("\n");
}

/**
 * Whether an observation is worth publishing at all.
 *
 * An agent on a schedule will run whether or not anything happened, and the failure mode of
 * that is a feed full of articles saying nothing changed. Publish when the numbers moved
 * against the last run, or when there was no last run.
 */
export function worthPublishing(observation, previous) {
  if (observation.ok === 0) return { publish: true, because: "every request failed" };
  if (previous === undefined || previous === null) return { publish: true, because: "no previous measurement" };
  if (observation.failed > previous.failed) return { publish: true, because: "more requests failed than last time" };

  const before = previous.p90_ms ?? 0;
  const now = observation.p90_ms ?? 0;
  if (before > 0 && Math.abs(now - before) / before >= 0.25) {
    return { publish: true, because: `p90 moved from ${before} ms to ${now} ms` };
  }
  return { publish: false, because: `p90 is within 25% of the last run (${before} ms → ${now} ms)` };
}

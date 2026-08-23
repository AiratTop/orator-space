import type { MetricsQuery } from "@orator/core/ports";

/**
 * Reading back what §66.2 wrote (SPEC §66.4, §66.6).
 *
 * Analytics Engine is written to through a binding and read through an HTTP API, which is
 * the asymmetry that made §66.4's two traffic indicators the hard ones: a Worker can count
 * a request in a microsecond and cannot ask what it counted without an account-scoped
 * credential. §80.15 leaves the choice of a metrics backend open; this is the smaller thing
 * that closes two rows without one — the platform queries its own dataset.
 *
 * **Unconfigured is a state, not a failure.** Without the account id and the token every
 * method answers null, and the SLO report says "unavailable" rather than claiming health it
 * cannot verify or raising an alert nobody can silence.
 */

export interface AnalyticsConfig {
  accountId: string | undefined;
  token: string | undefined;
  /** The dataset name, which the write binding does not expose to code. */
  dataset: string | undefined;
}

/** What `api.request` writes; the order in `metrics.ts` is the schema (§66.2). */
const PUBLISH_ROUTE = "/v1/articles/:id/publish";

export function createMetricsQuery(config: AnalyticsConfig): MetricsQuery {
  const { accountId, token, dataset } = config;
  const configured = Boolean(accountId && token && dataset);

  /**
   * One query against the SQL API.
   *
   * Every failure — unreachable, unauthorised, a schema that has moved — answers null. This
   * runs inside a health report, and a health check that throws because its own telemetry is
   * unavailable reports the wrong outage.
   */
  async function ask<T>(sql: string): Promise<T | null> {
    if (!configured) return null;
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
          body: sql,
        },
      );
      if (!response.ok) return null;
      const payload = (await response.json()) as { data?: T[] };
      return payload.data?.[0] ?? null;
    } catch {
      return null;
    }
  }

  return {
    /**
     * p95 of the publish request, from `api.request` rather than from `article.published`.
     *
     * §66.4 names `publishArticle`, and the number that matters is what a caller waited for:
     * the whole critical path of §36.1, request in to 201 out. The domain's own
     * `article.published` metric carries no duration — it is emitted after the commit, where
     * there is nothing left to time.
     *
     * Weighted by `_sample_interval`, because Analytics Engine samples under load and an
     * unweighted percentile over a sampled set is a percentile of the sample rather than of
     * the traffic.
     */
    async publishLatencyP95Ms(windowMinutes: number) {
      const row = await ask<{ p95: number | null }>(
        `SELECT quantileWeighted(0.95)(double1, _sample_interval) AS p95
           FROM ${dataset}
          WHERE timestamp > NOW() - INTERVAL '${Math.round(windowMinutes)}' MINUTE
            AND blob1 = 'api.request'
            AND blob3 = '${PUBLISH_ROUTE}'
         FORMAT JSON`,
      );
      return typeof row?.p95 === "number" ? row.p95 : null;
    },

    /**
     * The share of responses in the 5xx range.
     *
     * A fraction rather than a count, which is what §66.4 sets a threshold on: half a percent
     * of a busy minute and half a percent of a quiet one are the same fact about the service
     * and very different numbers of requests.
     *
     * Zero traffic answers null rather than zero. No requests is not a zero error rate, and
     * a deployment that has stopped receiving traffic entirely should not read as the
     * healthiest it has ever been.
     */
    async serverErrorRate(windowMinutes: number) {
      const row = await ask<{ errors: number; total: number }>(
        `SELECT
           sum(if(blob4 = '5xx', _sample_interval, 0)) AS errors,
           sum(_sample_interval) AS total
           FROM ${dataset}
          WHERE timestamp > NOW() - INTERVAL '${Math.round(windowMinutes)}' MINUTE
            AND blob1 = 'api.request'
         FORMAT JSON`,
      );
      if (row === null || typeof row.total !== "number" || row.total === 0) return null;
      return row.errors / row.total;
    },
  };
}

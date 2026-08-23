import type { MetricSample, MetricsQuery, MetricUnavailable } from "@orator/core/ports";

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

  const absent = (unavailable: MetricUnavailable): MetricSample => ({ value: null, unavailable });

  /**
   * One query against the SQL API.
   *
   * Every failure — unreachable, unauthorised, a schema that has moved — answers with no
   * rows rather than throwing. This runs inside a health report, and a health check that
   * fails because its own telemetry is unavailable reports the wrong outage.
   *
   * The failure is logged with the status and the first of the body, because that is the
   * difference between "the token is wrong" and "the function is not in the dialect", and
   * neither is visible from the report itself (§66.3 — a query is not a credential, and the
   * token is never in what is logged).
   */
  async function ask<T>(name: string, sql: string): Promise<T[] | null> {
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
          body: sql,
        },
      );
      if (!response.ok) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "analytics.query.refused",
            metric: name,
            status: response.status,
            detail: (await response.text()).slice(0, 300),
          }),
        );
        return null;
      }
      const payload = (await response.json()) as { data?: T[] };
      return payload.data ?? [];
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "analytics.query.failed",
          metric: name,
          error: String(error).slice(0, 300),
        }),
      );
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
      if (!configured) return absent("unconfigured");

      const rows = await ask<{ p95: number | null }>(
        "publish_p95",
        `SELECT quantileWeighted(0.95)(double1, _sample_interval) AS p95
           FROM ${dataset}
          WHERE timestamp > NOW() - INTERVAL '${Math.round(windowMinutes)}' MINUTE
            AND blob1 = 'api.request'
            AND blob3 = '${PUBLISH_ROUTE}'`,
      );
      if (rows === null) return absent("query-failed");

      // A percentile over nothing is not a number, and nobody published in the window often
      // enough for that to be the ordinary case rather than an outage.
      const p95 = rows[0]?.p95;
      return typeof p95 === "number" ? { value: p95 } : absent("no-traffic");
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
      if (!configured) return absent("unconfigured");

      /*
       * Grouped, rather than a conditional sum.
       *
       * `sum(if(blob4 = '5xx', …))` reads better and assumes `if` is in a dialect this code
       * cannot test against. `GROUP BY` and `sum` are the two things every SQL has, so the
       * arithmetic happens here instead — which costs one small object and removes an
       * assumption that would fail as "unavailable" with no way to tell why.
       */
      const rows = await ask<{ class: string; n: number }>(
        "server_error_rate",
        `SELECT blob4 AS class, sum(_sample_interval) AS n
           FROM ${dataset}
          WHERE timestamp > NOW() - INTERVAL '${Math.round(windowMinutes)}' MINUTE
            AND blob1 = 'api.request'
          GROUP BY class`,
      );
      if (rows === null) return absent("query-failed");

      const total = rows.reduce((sum, row) => sum + (Number(row.n) || 0), 0);
      // No traffic is not a zero error rate. A deployment that has stopped receiving requests
      // should not read as the healthiest it has ever been.
      if (total === 0) return absent("no-traffic");

      const errors = rows
        .filter((row) => row.class === "5xx")
        .reduce((sum, row) => sum + (Number(row.n) || 0), 0);
      return { value: errors / total };
    },
  };
}

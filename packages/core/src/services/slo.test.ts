import { describe, expect, it } from "vitest";
import type { MetricsQuery, SloRepo } from "../ports/slo.js";
import { evaluateSlo, THRESHOLDS, type Indicator, type SloReport } from "./slo.js";

/**
 * SPEC §66.4 — the eight indicators, and what each of them says.
 *
 * The thresholds themselves are the interesting part, and specifically the three states that
 * are not "ok" or "breached". An indicator nobody can measure must not read as healthy, an
 * indicator on its way to a limit must not wake anybody, and both are easy to collapse into
 * a boolean by accident.
 */

const NOW = new Date("2026-08-23T12:00:00.000Z");

const repo = (over: Partial<SloRepo> = {}): SloRepo => ({
  async outboxBacklog() {
    return { pending: 0, oldestPendingAt: null };
  },
  async sweepLastRun() {
    return { position: "ARTICLE-1", at: new Date(NOW.getTime() - 60_000).toISOString() };
  },
  async indexingLag() {
    return { sampled: 10, p95Seconds: 4 };
  },
  async deadLettered() {
    return 0;
  },
  async databaseBytes() {
    return 1_000_000;
  },
  async deleteDeadLettersBefore() {
    return 0;
  },
  ...over,
});

const metrics = (over: Partial<MetricsQuery> = {}): MetricsQuery => ({
  async publishLatencyP95Ms() {
    return { value: 120 };
  },
  async serverErrorRate() {
    return { value: 0.001 };
  },
  ...over,
});

const evaluate = (slo: SloRepo = repo(), query: MetricsQuery = metrics()): Promise<SloReport> =>
  evaluateSlo({ slo, metrics: query, clock: { now: () => NOW } });

const find = (report: SloReport, name: string): Indicator =>
  report.indicators.find((indicator) => indicator.name === name)!;

describe("a healthy pipeline", () => {
  it("reports every indicator it can measure, and one it cannot", async () => {
    const report = await evaluate();

    // §33.4's purge does not exist, so its indicator says so rather than disappearing.
    expect(find(report, "purge_failure_rate").state).toBe("not-implemented");
    expect(report.indicators).toHaveLength(8);

    // And a deliberate, documented absence does not degrade the report. A status that can
    // never read `ok` is a status nobody reads.
    expect(report.status).toBe("ok");
  });
});

describe("the backlog (§66.4)", () => {
  it("breaches on depth", async () => {
    const report = await evaluate(
      repo({ async outboxBacklog() { return { pending: THRESHOLDS.outboxDepth + 1, oldestPendingAt: NOW.toISOString() }; } }),
    );
    expect(find(report, "outbox_pending").state).toBe("breached");
    expect(report.status).toBe("breached");
  });

  it("breaches on age even when the depth is one", async () => {
    // The failure that matters most: a single message retrying forever is a depth of one and
    // a pipeline that has stopped for that aggregate.
    const stale = new Date(NOW.getTime() - (THRESHOLDS.outboxAgeSeconds + 60) * 1000).toISOString();
    const report = await evaluate(
      repo({ async outboxBacklog() { return { pending: 1, oldestPendingAt: stale }; } }),
    );
    expect(find(report, "outbox_pending").state).toBe("breached");
  });

  it("is content with a deep backlog that is moving", async () => {
    const report = await evaluate(
      repo({ async outboxBacklog() { return { pending: THRESHOLDS.outboxDepth, oldestPendingAt: NOW.toISOString() }; } }),
    );
    expect(find(report, "outbox_pending").state).toBe("ok");
  });
});

describe("the embedding sweep (§66.4, §38.2)", () => {
  /*
   * The indicator that exists because the drain stopped scanning.
   *
   * Asking "what has no current vector" re-establishes the answer on every run and reads the
   * whole corpus to do it. A sweep reads a window and remembers its place — and then a sweep
   * that has stopped and a sweep with nothing to do are both silent. The difference is every
   * article published after it stopped, missing from semantic search, indefinitely.
   */
  it("is healthy while the sweep keeps running, wherever it has got to", async () => {
    const report = await evaluate(
      repo({
        async sweepLastRun() {
          return { position: "", at: new Date(NOW.getTime() - 4 * 60_000).toISOString() };
        },
      }),
    );

    const sweep = find(report, "embedding_sweep");
    expect(sweep.state).toBe("ok");
    expect(sweep.value).toBe(240);
    // An empty position is the start of a lap, which is where a finished one leaves it — not
    // a sweep that has never moved.
    expect(sweep.detail).toBe("at the start of a lap");
  });

  it("breaches when it has been silent for longer than three runs of its cron", async () => {
    const report = await evaluate(
      repo({
        async sweepLastRun() {
          return {
            position: "ARTICLE-9",
            at: new Date(NOW.getTime() - (THRESHOLDS.sweepIdleMinutes + 1) * 60_000).toISOString(),
          };
        },
      }),
    );

    expect(find(report, "embedding_sweep").state).toBe("breached");
    expect(report.status).toBe("breached");
  });

  /*
   * A deployment with no vector store never starts the sweep, and §38.2 makes that a
   * documented degradation to lexical search rather than a fault. Breaching here would ring a
   * bell that fixing nothing can silence, which §66.4 says is the way to get a bell muted.
   */
  it("says it cannot measure rather than alerting where there is no sweep", async () => {
    const report = await evaluate(
      repo({
        async sweepLastRun() {
          return null;
        },
      }),
    );

    expect(find(report, "embedding_sweep").state).toBe("unavailable");
    expect(report.status).toBe("degraded");
  });
});

describe("indexing lag (§66.4, §34.4)", () => {
  it("breaches past a minute", async () => {
    const report = await evaluate(repo({ async indexingLag() { return { sampled: 20, p95Seconds: 61 }; } }));
    expect(find(report, "indexing_p95").state).toBe("breached");
  });

  it("says nothing was published rather than claiming health", async () => {
    const report = await evaluate(repo({ async indexingLag() { return { sampled: 0, p95Seconds: null }; } }));
    const indicator = find(report, "indexing_p95");
    expect(indicator.state).toBe("unavailable");
    expect(indicator.detail).toContain("nothing published");
  });
});

describe("the dead-letter queue (§66.4)", () => {
  it("treats one message as a breach, because five attempts already failed", async () => {
    const report = await evaluate(repo({ async deadLettered() { return 1; } }));
    expect(find(report, "dead_lettered").state).toBe("breached");
  });

  it("asks about a day, which is how long an operator has to notice", async () => {
    // The alert clears on its own — there is nothing to acknowledge — so the window is the
    // whole of the notice period. An hour of it passes while somebody is asleep.
    let asked: string | null = null;
    await evaluate(repo({ async deadLettered(since) { asked = since; return 0; } }));
    expect(Date.parse(NOW.toISOString()) - Date.parse(asked!)).toBe(24 * 3_600_000);
  });
});

describe("the database's size (§31.3, §66.4)", () => {
  const at = (fraction: number) => Math.round(THRESHOLDS.databaseLimitBytes * fraction);

  it("warns at 60% and does not wake anybody", async () => {
    const report = await evaluate(repo({ async databaseBytes() { return at(0.65); } }));
    expect(find(report, "database_bytes").state).toBe("warning");
    expect(report.status).toBe("degraded");
  });

  it("breaches at 80%", async () => {
    const report = await evaluate(repo({ async databaseBytes() { return at(0.85); } }));
    expect(find(report, "database_bytes").state).toBe("breached");
  });

  it("reports a platform that does not say as unavailable, not as empty", async () => {
    const report = await evaluate(repo({ async databaseBytes() { return null; } }));
    expect(find(report, "database_bytes").state).toBe("unavailable");
    expect(report.status).toBe("degraded");
  });
});

describe("the two indicators that need a metrics backend (§80.15)", () => {
  it("reports them as unavailable rather than as healthy", async () => {
    const report = await evaluate(
      repo(),
      metrics({
        async publishLatencyP95Ms() { return { value: null, unavailable: "unconfigured" }; },
        async serverErrorRate() { return { value: null, unavailable: "unconfigured" }; },
      }),
    );

    expect(find(report, "publish_p95").state).toBe("unavailable");
    expect(find(report, "server_error_rate").state).toBe("unavailable");
    // Unavailable is not an alert: a bell nobody can silence is a bell everybody mutes.
    expect(report.status).toBe("degraded");
  });

  /**
   * The three reasons are different next steps, and saying the wrong one sends an operator
   * to check something that is already correct.
   */
  it("says which kind of unavailable, not the same sentence for all three", async () => {
    const reasonFor = async (unavailable: "unconfigured" | "query-failed" | "no-traffic") => {
      const report = await evaluate(
        repo(),
        metrics({ async publishLatencyP95Ms() { return { value: null, unavailable }; } }),
      );
      return find(report, "publish_p95").detail ?? "";
    };

    expect(await reasonFor("unconfigured")).toContain("CF_ANALYTICS_TOKEN");
    expect(await reasonFor("query-failed")).toContain("did not answer");
    expect(await reasonFor("no-traffic")).toContain("nothing in the window");
  });

  it("breaches when they are measured and over the line", async () => {
    const report = await evaluate(
      repo(),
      metrics({
        async publishLatencyP95Ms() { return { value: THRESHOLDS.publishP95Ms + 1 }; },
        async serverErrorRate() { return { value: THRESHOLDS.serverErrorRate * 2 }; },
      }),
    );
    expect(find(report, "publish_p95").state).toBe("breached");
    expect(find(report, "server_error_rate").state).toBe("breached");
    expect(report.status).toBe("breached");
  });

  it("does not breach exactly at the threshold, which §66.4 states as `>`", async () => {
    const report = await evaluate(
      repo(),
      metrics({ async publishLatencyP95Ms() { return { value: THRESHOLDS.publishP95Ms }; } }),
    );
    expect(find(report, "publish_p95").state).toBe("ok");
  });
});

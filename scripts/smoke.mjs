#!/usr/bin/env node
/**
 * Post-deploy smoke check. Deliberately shallow — it answers "did this deploy come up",
 * not "does the pipeline work". The deep synthetic transaction (SPEC §66.7) belongs to
 * Phase 8 and runs continuously from outside, not once from CI.
 *
 *   smoke.mjs <api-base> [web-base]
 *
 * The second address is optional and is the only place production's *web* surface is
 * checked by anything. See the note above `indexing()`.
 */
const base = process.argv[2];
const web = process.argv[3];
if (!base) {
  console.error("usage: smoke.mjs <api-base> [web-base]");
  process.exit(2);
}

/** A fresh deployment can take a few seconds to become reachable everywhere. */
async function until(what, attempt) {
  const deadline = Date.now() + 60_000;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const outcome = await attempt();
      if (outcome === true) return;
      lastError = outcome;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  console.error(`smoke failed for ${what}: ${lastError}`);
  process.exit(1);
}

await until(base, async () => {
  const response = await fetch(`${base}/health`, { headers: { "x-request-id": "smoke" } });
  const body = await response.json();
  if (response.ok && body.status === "ok") {
    console.log(`ok  ${base}  environment=${body.environment}  checks=${JSON.stringify(body.checks)}`);
    return true;
  }
  return `status=${response.status} body=${JSON.stringify(body)}`;
});

/**
 * Whether this deployment is telling search engines the right thing about itself (§50.2).
 *
 * Shallow like the rest of this script, and here rather than in a checkpoint because of
 * where the failure it catches comes from. Which of the two answers a deployment gives is
 * decided by `ENVIRONMENT`, and `apps/web` reads that from a configuration flattened at
 * *build* time: a build with `CLOUDFLARE_ENV` unset produces a Worker named `orator-web`
 * carrying `ENVIRONMENT: "local"`, which has happened once already and is written up in
 * CLAUDE.md. Today that mistake would put `Disallow: /` and `noindex` on every page of the
 * production site, which answers 200 throughout and looks entirely healthy — and the cost
 * is measured in the weeks it takes to be crawled back, not in a redeploy.
 *
 * `e2e-read.mjs` asserts the same pair against staging on every push, so the closed shape
 * is covered by a checkpoint. The open one is not: nothing else in CI reads production's
 * web surface at all. Two public GETs, no credential, on documents that are served to
 * anyone who asks.
 */
async function indexing(origin) {
  const bust = `smoke=${Date.now()}`;
  // Past the edge cache, which holds robots.txt for an hour: a cached body can be older
  // than the deployment being checked, and then this asserts what the last build decided.
  const robots = await (await fetch(`${origin}/robots.txt?${bust}`)).text();
  const tag = (await fetch(`${origin}/?${bust}`)).headers.get("x-robots-tag") ?? "";

  const closed = /^User-agent:\s*\*\s*\nDisallow:\s*\/\s*$/im.test(robots) && tag.includes("noindex");
  const open = !/^Disallow:\s*\/\s*$/im.test(robots) && !tag.includes("noindex");
  const wanted = new URL(origin).hostname === "orator.space";

  if (wanted && open) return true;
  if (!wanted && closed) return true;
  return `${wanted ? "production must be open to indexing" : "this deployment must be closed to indexing"} — robots.txt ${closed ? "closes the site" : open ? "opens it" : "says neither clearly"}, x-robots-tag ${tag || "(none)"}`;
}

if (web) {
  await until(`${web} (indexing)`, () => indexing(web));
  console.log(`ok  ${web}  indexing policy matches the deployment`);
}

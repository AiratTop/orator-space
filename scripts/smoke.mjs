#!/usr/bin/env node
/**
 * Post-deploy smoke check. Deliberately shallow — it answers "did this deploy come up",
 * not "does the pipeline work". The deep synthetic transaction (SPEC §66.7) belongs to
 * Phase 8 and runs continuously from outside, not once from CI.
 */
const base = process.argv[2];
if (!base) {
  console.error("usage: smoke.mjs <base-url>");
  process.exit(2);
}

const deadline = Date.now() + 60_000;
let lastError = "no attempt made";

while (Date.now() < deadline) {
  try {
    const response = await fetch(`${base}/health`, { headers: { "x-request-id": "smoke" } });
    const body = await response.json();
    if (response.ok && body.status === "ok") {
      console.log(`ok  ${base}  environment=${body.environment}  checks=${JSON.stringify(body.checks)}`);
      process.exit(0);
    }
    lastError = `status=${response.status} body=${JSON.stringify(body)}`;
  } catch (error) {
    lastError = String(error?.message ?? error);
  }
  // A fresh deployment can take a few seconds to become reachable everywhere.
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

console.error(`smoke failed for ${base}: ${lastError}`);
process.exit(1);

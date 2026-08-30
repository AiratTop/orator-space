#!/usr/bin/env node
/**
 * Every Worker in a deployed environment holds the secrets it needs (SPEC §62, §66.4).
 *
 * `IP_PEPPER` is the case this exists for. `/health` reports it, but `/health` is the edge
 * Worker's and §63 keeps the health endpoints on the API host — so the *web* Worker's copy is
 * invisible from outside, and it has one: both surfaces write `ip_hash` into the same
 * `audit_log`, so a deployment where only one holds the pepper is one caller appearing as two
 * people, quietly, for as long as it lasts.
 *
 * Checked here rather than by adding a second health endpoint on `orator.space`, which would
 * put an operational surface on the reader-facing host and diverge from §63 to report one
 * boolean. This runs after the deploy that could have broken it, with the credential that
 * can see the answer, and fails the release rather than the request path.
 *
 * **What it establishes, and what it does not.** It reads names — `wrangler secret list`
 * returns no values, by design — so it proves each Worker holds *a* secret under that name.
 * It cannot prove the two hold the *same* value, which is what §62 actually requires of the
 * pair, and no amount of care here will: the platform does not disclose the values and
 * should not. Closing that would mean either setting both from one CI secret, which moves
 * the pepper into GitHub and out of the operator's hands, or having each Worker publish a
 * digest of its own — a second endpoint on the reader-facing host, which is the thing this
 * exists to avoid. The mismatch it cannot see is recorded in CONTEXT.md as an operator
 * procedure instead: set both from one value, in one sitting.
 *
 *   node scripts/check-secrets.mjs --env staging
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1];
};

const environment = flag("env");
if (environment !== "staging" && environment !== "production") {
  console.error("usage: node scripts/check-secrets.mjs --env staging|production");
  process.exit(2);
}

const suffix = environment === "staging" ? "-staging" : "";

/**
 * What each Worker must hold, and why — so a failure names the consequence rather than the
 * variable. Telegram's two are deliberately absent: §9.3 makes a deployment without a bot a
 * deployment with no Telegram at all, which is a supported state.
 */
const REQUIRED = [
  {
    worker: `orator-edge${suffix}`,
    name: "IP_PEPPER",
    why: "SPEC §62 — without it the stored address digest is keyed with the environment name, which is public, and an IPv4 address is enumerable against it.",
  },
  {
    worker: `orator-web${suffix}`,
    name: "IP_PEPPER",
    why: "SPEC §62 — and it must be the same value the edge Worker holds: both write ip_hash into one audit_log, so two peppers make one caller two people.",
  },
];

let failures = 0;

for (const { worker, name, why } of REQUIRED) {
  const result = spawnSync("npx", ["wrangler", "secret", "list", "--name", worker, "--format", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    console.error(`  FAIL  ${worker}: could not list secrets — ${(result.stderr ?? "").trim().slice(0, 300)}`);
    failures += 1;
    continue;
  }

  /*
   * Parsed, not searched. `stdout.includes("IP_PEPPER")` is satisfied by `OLD_IP_PEPPER`,
   * and a check that passes on a secret nobody reads is worse than no check — it reports
   * that the thing is configured while the Worker falls back.
   *
   * `--format json` on wrangler 4; the array-of-objects shape is what it returns, and a
   * failure to parse is a failure rather than a fall-through to a substring search.
   */
  let names;
  try {
    const out = result.stdout.slice(result.stdout.indexOf("["), result.stdout.lastIndexOf("]") + 1);
    names = JSON.parse(out).map((entry) => entry.name);
  } catch {
    console.error(`  FAIL  ${worker}: could not parse the secret listing — ${result.stdout.trim().slice(0, 200)}`);
    failures += 1;
    continue;
  }

  if (names.includes(name)) {
    console.log(`  ok    ${worker}  ${name}`);
  } else {
    console.error(`  FAIL  ${worker}  ${name} is not set\n        ${why}`);
    failures += 1;
  }
}

console.log(
  failures === 0
    ? `\nsecrets: ok — every Worker in ${environment} holds what it needs\n`
    : `\nsecrets: ${failures} missing in ${environment}\n`,
);
process.exit(failures === 0 ? 0 : 1);

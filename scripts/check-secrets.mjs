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
 * It reads names and never values — `wrangler secret list` returns no value to read.
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
  const result = spawnSync("npx", ["wrangler", "secret", "list", "--name", worker], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    console.error(`  FAIL  ${worker}: could not list secrets — ${(result.stderr ?? "").trim().slice(0, 300)}`);
    failures += 1;
    continue;
  }

  // The listing is JSON on recent wrangler and a table on older ones. The name is what
  // matters and it appears in both, so this looks for the name rather than parsing a shape
  // that has changed once already.
  if (result.stdout.includes(name)) {
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

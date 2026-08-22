#!/usr/bin/env node
/**
 * Creates the deep check's canary (SPEC §66.7).
 *
 * §66.7 requires the canary to have its own identity and to be marked as a system account,
 * which is what keeps its articles out of feeds, search, the sitemap, metrics and quotas.
 * A system account cannot be created through the API, deliberately: the flag exempts a
 * principal from the limits every participant is subject to, and nothing a caller can say
 * should be able to set it.
 *
 *   node scripts/create-canary.mjs --env staging|production [--dry-run]
 *
 * Prints the token once. Put it in Gatus as a bearer header on `/health/deep`.
 */
import { spawnSync } from "node:child_process";
import { newId } from "./lib/orator-id.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const environment = flag("env", null);
const dryRun = args.includes("--dry-run");

if (environment !== "staging" && environment !== "production") {
  console.error("usage: node scripts/create-canary.mjs --env staging|production [--dry-run]");
  process.exit(2);
}

const b62 = (bytes) => {
  const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out;
};

const sha256Hex = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const secret = new Uint8Array(32);
crypto.getRandomValues(secret);
const token = `orat_sk_live_${b62(secret)}`;
const tokenHash = await sha256Hex(token);
const prefix = token.slice(0, 20);

const now = new Date();
const principalId = newId(now);
const tokenId = newId(now);
const username = `canary-${environment}`;

/**
 * The scopes the check actually performs, and nothing else.
 *
 * It creates a draft, publishes it, searches for it and removes it. `articles:delete` is the
 * one that would matter if this token leaked, and it is unavoidable: §66.7's whole point is
 * that the canary removes what it published, and a canary that could not would fill the
 * database with its own heartbeat.
 */
const SCOPES = ["articles:read", "articles:write", "articles:publish", "articles:delete"];

const sql = [
  `INSERT INTO principals (id, kind, username, username_skeleton, display_name, status,`,
  `                        platform_role, system_account, created_at, updated_at)`,
  `VALUES ('${principalId}', 'agent', '${username}', '${username}', 'Deep health check',`,
  `        'active', 'user', 1, '${now.toISOString()}', '${now.toISOString()}');`,
  ``,
  `INSERT INTO agents (principal_id, owner_principal_id, model, provider, trust_level, created_at)`,
  `SELECT '${principalId}', id, 'none', 'orator', 0, '${now.toISOString()}'`,
  `  FROM principals WHERE platform_role = 'admin' AND kind = 'human' LIMIT 1;`,
  ``,
  `INSERT INTO api_tokens (id, principal_id, name, token_hash, prefix, scopes, created_at)`,
  `VALUES ('${tokenId}', '${principalId}', 'deep-health', '${tokenHash}', '${prefix}',`,
  `        '${JSON.stringify(SCOPES)}', '${now.toISOString()}');`,
].join("\n");

console.log(`\nCreating @${username} in ${environment}.\n`);
console.log(sql);

if (dryRun) {
  console.log("\n--dry-run: nothing was executed.\n");
  process.exit(0);
}

/*
 * §7.2 — even the canary has an accountable owner.
 *
 * The agents row selects an administrator rather than inventing an ownerless principal. If
 * no administrator exists the insert affects no rows and the principal has no agent record,
 * which fails loudly on the first authenticated call rather than creating an agent nobody
 * is answerable for.
 */
const result = spawnSync(
  "pnpm",
  ["--filter", "@orator/edge", "exec", "wrangler", "d1", "execute", "DB", "--env", environment, "--remote", "--command", sql],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  console.error("\nThe statements were not applied. The token above is worthless; run again.\n");
  process.exit(1);
}

console.log(`\n  ${token}\n`);
console.log("Shown once. Put it in Gatus as `Authorization: Bearer …` on /health/deep (§66.7).");
console.log(`Principal: ${principalId} — system account, so its articles never reach a feed.\n`);

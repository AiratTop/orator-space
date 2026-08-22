#!/usr/bin/env node
/**
 * Appoints the first moderator (SPEC §43.3, §61.1).
 *
 * There is no API for this, and there should not be. §43.3 appoints a platform role out of
 * band, and §43.1 refuses to issue an administrative scope to anybody who does not already
 * hold one. Both rules are right, and together they mean the first moderator is created by
 * writing to the database — so the procedure is a script in version control rather than a
 * sequence somebody reconstructs from the schema at the moment they need it.
 *
 * It prints the token once. Nothing stores it, and nothing can show it again.
 *
 *   node scripts/grant-moderator.mjs <principal-id> --env staging [--role moderator] [--dry-run]
 *
 * `--role admin` grants `admin:manage` as well, which is what appointing further moderators
 * requires (§43.1). Grant it to as few principals as the deployment can operate with.
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const principalId = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1]?.startsWith("--") !== true);
const environment = flag("env", null);
const role = flag("role", "moderator");
const dryRun = args.includes("--dry-run");

if (principalId === undefined || environment === null) {
  console.error("usage: node scripts/grant-moderator.mjs <principal-id> --env staging|production [--role moderator|admin] [--dry-run]");
  process.exit(2);
}
if (role !== "moderator" && role !== "admin") {
  console.error(`unknown role: ${role}. One of moderator, admin.`);
  process.exit(2);
}

/**
 * §43.1 — the scopes a moderator needs and nothing more.
 *
 * Reading is included because the queue is unusable without it: a moderator who cannot open
 * the article they are deciding about is deciding blind. `admin:manage` is not, unless the
 * role is `admin` — appointing further moderators is a different power from acting on
 * content, and most people who need the second do not need the first.
 */
const SCOPES = ["admin:moderate", "articles:read", "comments:read", "agents:read", "events:read"];
if (role === "admin") SCOPES.push("admin:manage");

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

/**
 * The same shape `generateToken` produces (§42.2).
 *
 * Rebuilt here rather than imported because this script runs against a deployed database
 * with `wrangler`, outside the workspace's module graph — and a token whose format drifted
 * from the one the Worker parses would fail authentication with no explanation. The prefix
 * and the hash are what the server actually compares, and both are computed the same way.
 */
const secret = new Uint8Array(32);
crypto.getRandomValues(secret);
const token = `orat_sk_live_${b62(secret)}`;
const tokenHash = await sha256Hex(token);
const prefix = token.slice(0, 20);

// Sortable, like every other id in the system (§12.2). Not the server's generator, but the
// same shape and the same ordering property.
const now = new Date();
const tokenId = `06${now.getTime().toString(32).toUpperCase().padStart(11, "0")}${b62(secret.slice(0, 8)).slice(0, 13).toUpperCase().padEnd(13, "0")}`;

const sql = [
  `UPDATE principals SET platform_role = '${role}' WHERE id = '${principalId}' AND kind = 'human';`,
  `INSERT INTO api_tokens (id, principal_id, name, token_hash, prefix, scopes, created_at)`,
  `VALUES ('${tokenId}', '${principalId}', '${role}', '${tokenHash}', '${prefix}',`,
  `        '${JSON.stringify(SCOPES)}', '${now.toISOString()}');`,
].join("\n");

console.log(`\nAppointing ${principalId} as ${role} in ${environment}.\n`);
console.log(sql);

if (dryRun) {
  console.log("\n--dry-run: nothing was executed.\n");
  process.exit(0);
}

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
console.log("Shown once. Nothing stored it and nothing can show it again (§42.2).");
console.log("Only a human principal can hold a platform role: the UPDATE above says so, and");
console.log("an agent id will have changed nothing while still minting a token (§7.2).\n");

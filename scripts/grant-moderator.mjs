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
import { isOratorId, newId } from "./lib/orator-id.mjs";

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
/*
 * Both of the values that reach SQL are checked against a closed set before they get there.
 *
 * `role` was already; `environment` and `principalId` were not, and this script interpolates
 * all three into a statement it hands to `wrangler d1 execute`. There is no parameter binding
 * on that path — `--command` takes a string — so the check *is* the defence, and it has to be
 * a whitelist rather than an escape. An id is 26 characters from a 32-character alphabet
 * containing no quote; an environment is one of two words.
 */
if (environment !== "staging" && environment !== "production") {
  console.error(`unknown environment: ${environment}. One of staging, production.`);
  process.exit(2);
}
if (!isOratorId(principalId)) {
  console.error(`not an identifier: ${principalId}. 26 Crockford base32 characters (§12).`);
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

const now = new Date();
const tokenId = newId(now);

/** One `wrangler d1 execute`, returning parsed rows. */
function d1(sql, { json = false } = {}) {
  const argv = ["--filter", "@orator/edge", "exec", "wrangler", "d1", "execute", "DB", "--env", environment, "--remote", "--command", sql];
  if (json) argv.push("--json");
  const result = spawnSync("pnpm", argv, { encoding: "utf8", stdio: json ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed: ${(result.stderr ?? "").slice(0, 600)}`);
  }
  if (!json) return null;
  const out = result.stdout ?? "";
  const at = out.indexOf("[");
  if (at === -1) throw new Error(`unexpected wrangler output: ${out.slice(0, 300)}`);
  return JSON.parse(out.slice(at, out.lastIndexOf("]") + 1))[0].results;
}

/*
 * Read the target first, and refuse anything that is not exactly one active human (§7.2).
 *
 * This used to go straight to the writes and lean on `WHERE kind = 'human'` to make an agent
 * id a no-op. It is a no-op for the UPDATE and was never one for the INSERT: an agent id
 * changed no role and still minted a token carrying `admin:moderate`, after which the script
 * printed it as a success. The domain checks the platform role as well as the scope (§43.4),
 * so nothing was escalated — but the operator was told a moderator existed who did not, and
 * a live administrative credential was left behind for an account nobody had appointed.
 */
console.log(`\nAppointing ${principalId} as ${role} in ${environment}.\n`);

const [target] = d1(`SELECT id, kind, status, platform_role, username FROM principals WHERE id = '${principalId}';`, { json: true });

if (target === undefined) {
  console.error(`No principal ${principalId} in ${environment}. Nothing was written.\n`);
  process.exit(1);
}
if (target.kind !== "human") {
  console.error(`${principalId} is @${target.username}, a ${target.kind}. Only a human holds a platform role (§7.2). Nothing was written.\n`);
  process.exit(1);
}
if (target.status !== "active") {
  console.error(`@${target.username} is ${target.status}. Nothing was written.\n`);
  process.exit(1);
}
console.log(`  target: @${target.username} (${target.kind}, ${target.status}, role ${target.platform_role ?? "none"})\n`);

/*
 * The INSERT selects its own precondition rather than trusting the UPDATE that precedes it.
 * `wrangler d1 execute` runs several statements in one call but gives no transaction to roll
 * back, so the token's existence has to depend on the role being grantable in the same
 * statement that creates it.
 */
const sql = [
  `UPDATE principals SET platform_role = '${role}' WHERE id = '${principalId}' AND kind = 'human' AND status = 'active';`,
  `INSERT INTO api_tokens (id, principal_id, name, token_hash, prefix, scopes, created_at)`,
  `SELECT '${tokenId}', '${principalId}', '${role}', '${tokenHash}', '${prefix}', '${JSON.stringify(SCOPES)}', '${now.toISOString()}'`,
  `WHERE EXISTS (SELECT 1 FROM principals WHERE id = '${principalId}' AND kind = 'human' AND platform_role = '${role}');`,
].join("\n");

console.log(sql);

if (dryRun) {
  console.log("\n--dry-run: nothing was executed.\n");
  process.exit(0);
}

try {
  d1(sql);
} catch (error) {
  console.error(`\n${error.message}\n\nThe token was never printed and nothing depends on it.\n`);
  process.exit(1);
}

/*
 * Postconditions, before the token is shown. A credential printed on the strength of an exit
 * code is a credential printed on the strength of nothing in particular.
 */
const [after] = d1(`SELECT platform_role FROM principals WHERE id = '${principalId}';`, { json: true });
const [minted] = d1(`SELECT id FROM api_tokens WHERE id = '${tokenId}';`, { json: true });

if (after?.platform_role !== role) {
  console.error(`\nThe role was not granted — @${target.username} is ${after?.platform_role ?? "unchanged"}. The token was not created either; nothing to revoke.\n`);
  process.exit(1);
}
if (minted === undefined) {
  console.error(`\nThe role is now ${role}, and the token was not created. Re-run to mint one.\n`);
  process.exit(1);
}

console.log(`\n  ${token}\n`);
console.log("Shown once. Nothing stored it and nothing can show it again (§42.2).");
console.log(`Verified: @${target.username} holds ${role}, and token ${tokenId} exists.\n`);

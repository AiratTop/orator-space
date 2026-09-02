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
 *   node scripts/create-canary.mjs --env staging|production --reissue
 *
 * Prints the token once. Put it in Gatus as a bearer header on `/health/deep`.
 *
 * `--reissue` is for the token having been lost rather than leaked — it is printed once and
 * a monitor that never got it leaves no trace. It keeps the principal, because §11 makes an
 * identifier permanent and a new canary for a lost password is a second identity for one
 * account. The old token is revoked in the same statement as the new one is written: a
 * reissue that leaves the previous credential valid is not a reissue.
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
const reissue = args.includes("--reissue");

if (environment !== "staging" && environment !== "production") {
  console.error("usage: node scripts/create-canary.mjs --env staging|production [--dry-run] [--reissue]");
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
let principalId = newId(now);
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

/**
 * The owner is found before anything is written (SPEC §7.2).
 *
 * The first version of this selected one inline:
 *
 *     INSERT INTO agents (...) SELECT '<canary>', id FROM principals
 *      WHERE platform_role = 'admin' AND kind = 'human' LIMIT 1;
 *
 * With no administrator that statement inserts zero rows and reports success, leaving a
 * principal marked `agent` with no `agents` row — an agent with no accountable human, which
 * is the one thing §7.2 exists to prevent. The comment beside it claimed the mistake would
 * "fail loudly on the first authenticated call". It would not: it would fail an hour later
 * as an authentication error in a monitor, with nothing pointing back here.
 *
 * Both environments turned out to have no administrator, so this was not a hypothetical.
 */
function query(sql) {
  const raw = spawnSync(
    "pnpm",
    ["--filter", "@orator/edge", "exec", "wrangler", "d1", "execute", "DB", "--env", environment, "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (raw.status !== 0) throw new Error(`query failed: ${(raw.stderr ?? "").slice(0, 400)}`);
  const out = raw.stdout ?? "";
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

// `--reissue` reads the principal even in a dry run: a preview that shows a fresh id is a
// preview of a different operation than the one that would run.
if (!dryRun || reissue) {
  const existing = query(`SELECT id FROM principals WHERE username = '${username}'`);
  if (existing.length > 0 && !reissue) {
    console.error(`\n  @${username} already exists (${existing[0].id}).`);
    console.error("  Pass --reissue to revoke its tokens and print a new one.\n");
    process.exit(1);
  }
  if (existing.length === 0 && reissue) {
    console.error(`\n  There is no @${username} in ${environment} to reissue a token for.\n`);
    process.exit(1);
  }
  if (existing.length > 0) principalId = existing[0].id;
}

const admins = dryRun || reissue
  ? [{ id: "<an admin principal id>" }]
  : query(`SELECT id, username FROM principals WHERE platform_role = 'admin' AND kind = 'human' LIMIT 1`);

if (admins.length === 0) {
  console.error(`\n  No administrator exists in ${environment}, so the canary would have no owner.\n`);
  console.error("  §7.2 makes a human accountable for every agent, and that is not a formality here:");
  console.error("  the owner is who answers for what the agent publishes, and an agent without one is");
  console.error("  a principal nothing in the system can hold responsible.\n");
  console.error("  Register yourself and take the role first:\n");
  console.error(`    curl -X POST https://api${environment === "production" ? "" : "-staging"}.orator.space/v1/humans \\`);
  console.error(`      -H 'content-type: application/json' -d '{"username":"..."}'`);
  console.error(`    node scripts/grant-moderator.mjs <principal-id> --env ${environment} --role admin\n`);
  process.exit(1);
}

const ownerId = admins[0].id;

const create = [
  `INSERT INTO principals (id, kind, username, username_skeleton, display_name, status,`,
  `                        platform_role, system_account, created_at, updated_at)`,
  `VALUES ('${principalId}', 'agent', '${username}', '${username}', 'Deep health check',`,
  `        'active', 'user', 1, '${now.toISOString()}', '${now.toISOString()}');`,
  ``,
  `INSERT INTO agents (principal_id, owner_principal_id, model, provider, trust_level, created_at)`,
  `VALUES ('${principalId}', '${ownerId}', 'none', 'orator', 0, '${now.toISOString()}');`,
  ``,
];

const sql = [
  ...(reissue
    ? [
        `UPDATE api_tokens SET revoked_at = '${now.toISOString()}'`,
        ` WHERE principal_id = '${principalId}' AND revoked_at IS NULL;`,
        ``,
      ]
    : create),
  `INSERT INTO api_tokens (id, principal_id, name, token_hash, prefix, scopes, created_at)`,
  `VALUES ('${tokenId}', '${principalId}', 'deep-health', '${tokenHash}', '${prefix}',`,
  `        '${JSON.stringify(SCOPES)}', '${now.toISOString()}');`,
].join("\n");

console.log(
  reissue
    ? `\nReissuing the token of @${username} in ${environment} (${principalId}).\n`
    : `\nCreating @${username} in ${environment}.\n`,
);
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

/*
 * Verified, not assumed.
 *
 * Three inserts and a transient API failure between any two of them would leave a principal
 * that authenticates as an agent with no owner. Reading the rows back costs one query and
 * turns a silent half-creation into a message that says which half.
 */
const check = query(
  `SELECT (SELECT COUNT(*) FROM principals WHERE id = '${principalId}') AS principal,
          (SELECT COUNT(*) FROM agents WHERE principal_id = '${principalId}') AS agent,
          (SELECT COUNT(*) FROM api_tokens WHERE id = '${tokenId}') AS token,
          (SELECT COUNT(*) FROM api_tokens
            WHERE principal_id = '${principalId}' AND revoked_at IS NULL) AS active`,
)[0];

if (check.principal !== 1 || check.agent !== 1 || check.token !== 1 || check.active !== 1) {
  console.error(`\n  Partly created: ${JSON.stringify(check)}. Remove @${username} and run again.\n`);
  process.exit(1);
}

console.log(`\n  ${token}\n`);
console.log("Shown once. Put it in Gatus as `Authorization: Bearer …` on /health/deep (§66.7).");
console.log(`Principal: ${principalId} — a system account owned by ${admins[0].username ?? ownerId},`);
console.log("so its articles never reach a feed, a metric or a quota (§66.7).\n");

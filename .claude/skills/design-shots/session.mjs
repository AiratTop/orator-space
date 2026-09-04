/**
 * A session in the *local* database, so that the pages behind sign-in can be looked at.
 *
 * `/settings`, `/moderation` and `/bookmarks` are a third of this site and none of them
 * could be screenshotted: sign-in is a passkey ceremony (ADR 0004) and a headless browser
 * has no authenticator. Pages nobody can render are pages that get designed by reading their
 * templates.
 *
 * ## Why this lives in the skill and not in the application
 *
 * The first attempt was a `/dev/signin` route in `apps/web`, guarded by `import.meta.env.DEV`
 * on the assumption that the build would fold it away. The build kept it — a route reached
 * through the manifest keeps its imports whatever its first line says — so an auth bypass
 * shipped to production with a boolean in front of it. Moving it behind an `injectRoute`
 * under `command === "dev"` was the right shape and did not register at all on Astro 7.2.4.
 *
 * So it is not application code. Nothing about signing in changes, no route exists that did
 * not exist, and there is no deployment for a mistake here to reach: this writes a row to the
 * miniflare database under `.wrangler-state`, which only a dev server ever opens.
 *
 * What it produces is an ordinary session. The table is `sessions` as `0001_init.sql` defines
 * it, the cookie is the token and the column is its SHA-256, so the middleware resolves it by
 * exactly the path a real one takes and the page cannot tell the difference. That is the
 * point: a screenshot of a state the application cannot produce is worth nothing.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `packages/protocol/src/ids.ts` — 16 bytes as 26 Crockford base32 characters (§12). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeId(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value <<= 2n;
  const out = new Array(26);
  for (let i = 25; i >= 0; i--) {
    out[i] = CROCKFORD[Number(value & 31n)];
    value >>= 5n;
  }
  return out.join("");
}

/** A UUIDv7, the way `packages/adapters-cf/src/id-gen.ts` lays one out. */
function nextId() {
  const bytes = new Uint8Array(16);
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70; /* version 7, counter zero — one id per call is all this needs */
  bytes[7] = 0;
  const random = randomBytes(8);
  bytes[8] = 0x80 | (random[0] & 0x3f); /* variant 10 */
  for (let i = 1; i < 8; i++) bytes[8 + i] = random[i];
  return encodeId(bytes);
}

/**
 * The database, addressed exactly one way.
 *
 * `--local` and `--persist-to` are written here rather than passed in, so there is no
 * argument anybody could set that would point this at a deployed database. `.wrangler-state`
 * is the shared miniflare directory both dev servers use (`apps/web/astro.config.mjs`).
 */
async function query(repoRoot, sql) {
  const { stdout } = await run(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      `${repoRoot}/.wrangler-state`,
      "--json",
      "--command",
      sql,
    ],
    { cwd: `${repoRoot}/apps/edge`, maxBuffer: 1024 * 1024 * 8 },
  );
  /* `--json` still prints wrangler's banner first on some versions. Take the JSON. */
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error(`wrangler returned no JSON:\n${stdout}`);
  return JSON.parse(stdout.slice(start))[0].results;
}

/** SQL string literal. Usernames are `a-z0-9-_` by §7.3, but this is not the place to rely on that. */
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * Opens a session for a username and returns the cookie value.
 *
 * Fourteen days, which is not the application's own lifetime and does not need to be — the
 * row exists for as long as a design session does.
 */
export async function mintSession(repoRoot, username) {
  const found = await query(
    repoRoot,
    `SELECT id, status FROM principals WHERE username = ${quote(username)}`,
  );
  if (found.length === 0) {
    throw new Error(`no principal is called @${username} in the local database`);
  }
  if (found[0].status !== "active") {
    throw new Error(`@${username} is ${found[0].status}, so it cannot hold a session`);
  }

  const token = `sess.${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  await query(
    repoRoot,
    `INSERT INTO sessions (id, principal_id, token_hash, user_agent, ip_hash, created_at, last_seen_at, expires_at, revoked_at)
     VALUES (${quote(nextId())}, ${quote(found[0].id)}, ${quote(tokenHash)}, 'design-shots', NULL,
             ${quote(now.toISOString())}, ${quote(now.toISOString())}, ${quote(expires.toISOString())}, NULL)`,
  );

  return token;
}

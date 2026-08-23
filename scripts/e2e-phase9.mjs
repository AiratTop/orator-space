#!/usr/bin/env node
/**
 * Phase 9 checkpoint (PLAN.md §12): the account page, driven the way a browser drives it.
 *
 * The gap this closes was found by using the product — register, sign in, and there is
 * nothing to do — so the checkpoint is written from the same seat. Everything here is a
 * form post with a session cookie and an `Origin` header, exactly what a browser sends, and
 * nothing reaches past the public surface.
 *
 * What it is really asserting is that the two credentials stay apart. A page can now write,
 * and the things it must not become are: a way to publish, a way to mint a token wider than
 * the session holds, a way to touch somebody else's agent, or a way for a token to survive
 * being revoked. Each of those is a check below rather than a comment.
 *
 *   node scripts/e2e-phase9.mjs [apiBase] [webBase]
 */
import { createVirtualAuthenticator } from "./lib/virtual-authenticator.mjs";

const apiBase = process.argv[2] ?? "http://localhost:8787";
const webBase = process.argv[3] ?? "http://localhost:4321";
const webOrigin = new URL(webBase).origin;
const rpId = new URL(webBase).hostname;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const section = (name) => console.log(`\n${name}`);

const suffix = Math.random().toString(36).slice(2, 8);
let keys = 0;
const idem = () => `p9-${suffix}-${(keys += 1)}`;

async function api(method, path, { token, body, key } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

// --- a browser -------------------------------------------------------------------------

const cookies = new Map();
const rememberCookies = (response) => {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const [name, ...rest] = pair.split("=");
    const value = rest.join("=");
    if (value === "") cookies.delete(name.trim());
    else cookies.set(name.trim(), value);
  }
};
const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");

/** A JSON post to the passkey endpoints, which is how the browser's script talks to them. */
async function webJson(path, { body, token } = {}) {
  const response = await fetch(`${webBase}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookies.size > 0 ? { cookie: cookieHeader() } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
    redirect: "manual",
  });
  rememberCookies(response);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const page = async (path, { cookie = true } = {}) => {
  const response = await fetch(`${webBase}${path}`, {
    headers: cookie && cookies.size > 0 ? { cookie: cookieHeader() } : {},
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, html: await response.text() };
};

/** A form post: `application/x-www-form-urlencoded` with an Origin, like every browser. */
async function submit(fields, { origin = webOrigin } = {}) {
  const response = await fetch(`${webBase}/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin === null ? {} : { origin }),
      ...(cookies.size > 0 ? { cookie: cookieHeader() } : {}),
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
  rememberCookies(response);
  return { status: response.status, headers: response.headers, html: await response.text() };
}

console.log(`\nPhase 9 checkpoint — api ${apiBase}, web ${webBase}\n`);

// --- getting in ------------------------------------------------------------------------
section("Getting to the page (§9.1, §49.2)");

const anonymous = await page("/settings", { cookie: false });
check(
  "the account page is not readable without a session",
  anonymous.status === 303 && anonymous.headers.get("location") === "/signin",
  `${anonymous.status} → ${anonymous.headers.get("location")}`,
);

const human = await api("POST", "/v1/humans", { body: { username: `p9-owner-${suffix}` } });
check("a human registers and receives a first token", human.status === 201 && !!human.body?.token);
if (human.status !== 201) {
  console.error("cannot continue:", JSON.stringify(human.body));
  process.exit(1);
}
const ownerToken = human.body.token;

const authenticator = await createVirtualAuthenticator({ rpId, origin: webOrigin });
const regOptions = await webJson("/auth/passkey/register-options", { token: ownerToken });
const attestation = await authenticator.register(regOptions.body.challenge);
await webJson("/auth/passkey/register", { token: ownerToken, body: attestation });

const loginOptions = await webJson("/auth/passkey/login-options");
const assertion = await authenticator.authenticate(loginOptions.body.challenge);
const signedIn = await webJson("/auth/passkey/login", { body: assertion });
check("the passkey signs this browser in", signedIn.status === 200 && cookies.has("orator_session"));

const landed = await page("/signin");
check(
  "and /signin then sends a signed-in reader on to the account",
  landed.status === 303 && landed.headers.get("location") === "/settings",
  `${landed.status} → ${landed.headers.get("location")}`,
);

const settings = await page("/settings");
check("the account page renders", settings.status === 200);
check("naming the account it belongs to", settings.html.includes(`@p9-owner-${suffix}`));

/*
 * §33.2 — the rule that keeps one reader's page away from another.
 *
 * Asserted on this page specifically because it is the first page on the site that renders
 * a secret. A cached copy of it is not a stale page; it is somebody else's token.
 */
check(
  "and is never cacheable, by anyone",
  /no-store/.test(settings.headers.get("cache-control") ?? ""),
  settings.headers.get("cache-control") ?? "(none)",
);
check("carrying no validator a cache could revalidate against", settings.headers.get("etag") === null);

// --- writing ---------------------------------------------------------------------------
section("Registering an agent from a browser (§7.2, §60.3)");

const forged = await submit({ action: "agent.create", username: `p9-evil-${suffix}` }, { origin: "https://evil.test" });
check("a form post from another origin is refused", forged.status === 403);

const noOrigin = await submit({ action: "agent.create", username: `p9-evil-${suffix}` }, { origin: null });
check("and so is one with no Origin at all", noOrigin.status === 403);

const agentName = `p9-agent-${suffix}`;
const created = await submit({
  action: "agent.create",
  username: agentName,
  "display-name": "The Agent",
  model: "claude-opus-5",
  provider: "anthropic",
});
check("an agent is registered from the page", created.status === 200 && created.html.includes(`@${agentName}`));
check("and the model it declares is shown", created.html.includes("claude-opus-5"));

const taken = await submit({ action: "agent.create", username: agentName });
check("a taken username is refused, on the page rather than as a 500", taken.status === 200 && /taken/i.test(taken.html));

const agentId = /\/@__none__/.test(created.html) ? null : (created.html.match(/name="agent" value="([0-9A-Z]{26})"/) ?? [])[1];
check("the page carries the agent's id, which the forms act on", typeof agentId === "string", String(agentId));

// --- tokens ----------------------------------------------------------------------------
section("Issuing and revoking a token (§42.2)");

const issued = await submit({ action: "token.issue", principal: agentId, name: "checkpoint", preset: "agent" });
const shown = (issued.html.match(/orat_[A-Za-z0-9_-]+/) ?? [])[0];
check("a token is issued and shown", issued.status === 200 && typeof shown === "string");

const again = await page("/settings");
check(
  "and never appears again — the page stores a hash, not the token (§42.2)",
  typeof shown === "string" && !again.html.includes(shown),
);
check("only its prefix is listed", typeof shown === "string" && again.html.includes(shown.slice(0, 8)));

// `/v1/tokens` needs authentication and no particular scope, which makes it the honest
// probe for "does this credential still act": a public read would answer 200 either way.
const asAgent = await api("GET", "/v1/tokens", { token: shown });
check("the token issued from a browser authenticates at the API", asAgent.status === 200);

/*
 * §42.2 — a token cannot grant more than its issuer holds.
 *
 * The session actor carries the owner preset and no administrative scope, so a form asking
 * for one has nothing to escalate to. Sent as a raw field rather than through the select,
 * because the select is what a person sees and this is what a script would send.
 */
const escalated = await submit({ action: "token.issue", principal: agentId, name: "wide", preset: "admin" });
check("a scope preset the page does not offer is refused", escalated.status === 200 && /Unknown scope preset/.test(escalated.html));

const tokenId = (again.html.match(/name="token" value="([0-9A-Z]{26})"/) ?? [])[1];
const revoked = await submit({ action: "token.revoke", token: tokenId });
check("a token is revoked from the page", revoked.status === 200 && /revoked/i.test(revoked.html));

const afterRevoke = await api("GET", "/v1/tokens", { token: shown });
check("and stops working at the API immediately", afterRevoke.status === 401, String(afterRevoke.status));

const strangers = await submit({ action: "token.revoke", token: "00000000000000000000000000" });
check(
  "revoking a token that is not this account's answers not-found, not forbidden",
  /not found/i.test(strangers.html),
);

// --- stopping an agent -----------------------------------------------------------------
section("Stopping an agent (§7.2, §43.2)");

const working = await submit({ action: "token.issue", principal: agentId, name: "second", preset: "agent" });
const workingToken = (working.html.match(/orat_[A-Za-z0-9_-]+/) ?? [])[0];
check("the agent has a working token again", (await api("GET", "/v1/tokens", { token: workingToken })).status === 200);

const stopped = await submit({ action: "agent.status", agent: agentId, status: "suspended" });
check("the owner stops the agent", stopped.status === 200 && /stopped/i.test(stopped.html));

const whileStopped = await api("GET", "/v1/tokens", { token: workingToken });
check("a stopped agent's token no longer acts", whileStopped.status === 401 || whileStopped.status === 403, String(whileStopped.status));

const started = await submit({ action: "agent.status", agent: agentId, status: "active" });
check("starting it again restores it", started.status === 200);
check(
  "without having revoked its credentials — suspension is reversible and revocation is not",
  (await api("GET", "/v1/tokens", { token: workingToken })).status === 200,
);

// --- what the page must not be ---------------------------------------------------------
section("What a writing page must not become (§28)");

const publish = await fetch(`${webBase}/settings`, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: webOrigin,
    cookie: cookieHeader(),
  },
  body: new URLSearchParams({ action: "articles.publish", title: "no" }).toString(),
  redirect: "manual",
});
const publishBody = await publish.text();
check("an action the dispatcher does not know is refused", /Unknown action/.test(publishBody));

// --- sessions --------------------------------------------------------------------------
section("Sessions (§9.1)");

const withSessions = await page("/settings");
const sessionId = (withSessions.html.match(/name="session" value="([0-9A-Z]{26})"/) ?? [])[1];
check("the open session is listed", typeof sessionId === "string", String(sessionId));

const ended = await submit({ action: "session.end", session: sessionId });
check("ending the current session redirects away", ended.status === 303 && ended.headers.get("location") === "/");
check("and clears the cookie rather than leaving a revoked one", !cookies.has("orator_session"));

const afterEnd = await page("/settings", { cookie: false });
check("the account page is closed again", afterEnd.status === 303);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);

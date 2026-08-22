#!/usr/bin/env node
/**
 * Phase 3 checkpoint (PLAN.md §6): the whole publishing path against a running worker.
 *
 * Exercises the parts that are only real once storage, HTTP and the queue are involved:
 * atomicity of the outbox write, idempotent replay, optimistic concurrency, and signature
 * verification over a revision the server identified.
 */
const base = process.argv[2] ?? "http://localhost:8787";
const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

async function call(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

const suffix = Math.random().toString(36).slice(2, 8);
const BODY = "# Measuring cold start\n\nA hundred invocations per runtime, same payload, same region.\n";

console.log(`\nPhase 3 checkpoint against ${base}\n`);

// --- setup -----------------------------------------------------------------
const human = await call("POST", "/v1/humans", { body: { username: `owner-${suffix}` } });
check("human registers and receives a first token", human.status === 201 && !!human.body.token);
const ownerToken = human.body.token;

const agent = await call("POST", "/v1/agents", {
  token: ownerToken,
  body: { username: `researcher-${suffix}`, model: "claude-opus-5", provider: "anthropic" },
});
check("agent is created under that human", agent.status === 201);
const agentId = agent.body.principal_id;

const agentToken = (
  await call("POST", "/v1/tokens", {
    token: ownerToken,
    headers: { "idempotency-key": `publish-token-${suffix}` },
    body: { principal_id: agentId, name: "agent" },
  })
).body.token;

// --- creation --------------------------------------------------------------
const idemKey = `create-${suffix}`;
const created = await call("POST", "/v1/articles", {
  token: agentToken,
  headers: { "idempotency-key": idemKey },
  body: { title: "Measuring cold start", content: BODY },
});
check("article is created", created.status === 201, created.body?.title ?? "");
check("response carries an ETag", created.headers.get("etag")?.includes(created.body?.contentHash ?? "x"));
check("response carries Location", created.headers.get("location") === created.body?.url);
const articleId = created.body.id;

const noKey = await call("POST", "/v1/articles", {
  token: agentToken,
  body: { title: "No key", content: BODY },
});
check("creation without Idempotency-Key is refused", noKey.status === 422);

const replay = await call("POST", "/v1/articles", {
  token: agentToken,
  headers: { "idempotency-key": idemKey },
  body: { title: "Measuring cold start", content: BODY },
});
check("replaying the key returns the same article", replay.body?.id === articleId);

const reused = await call("POST", "/v1/articles", {
  token: agentToken,
  headers: { "idempotency-key": idemKey },
  body: { title: "Different", content: BODY },
});
check("the same key with a different body is refused", reused.status === 422);

// --- revisions and concurrency ---------------------------------------------
const stale = await call("POST", `/v1/articles/${articleId}/revisions`, {
  token: agentToken,
  headers: { "idempotency-key": `rev-stale-${suffix}`, "if-match": '"06G20000000000000000000000"' },
  body: { title: "Measuring cold start", content: BODY + "\nEdited.\n" },
});
check("a stale If-Match is rejected with 412", stale.status === 412, stale.body?.title ?? "");

const revision = await call("POST", `/v1/articles/${articleId}/revisions`, {
  token: agentToken,
  headers: { "idempotency-key": `rev-ok-${suffix}`, "if-match": `"${created.body.revisionId}"` },
  body: { title: "Measuring cold start", content: BODY + "\nEdited.\n" },
});
check("a current If-Match is accepted", revision.status === 201);

const unchanged = await call("POST", `/v1/articles/${articleId}/revisions`, {
  token: agentToken,
  headers: { "idempotency-key": `rev-same-${suffix}` },
  body: { title: "Measuring cold start", content: BODY + "\nEdited.\n" },
});
check("identical content creates no new revision", unchanged.body?.unchanged === true);

// --- signing and publishing ------------------------------------------------
const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicKey = b64url(await crypto.subtle.exportKey("raw", keyPair.publicKey));

const challenge = await call("POST", `/v1/agents/${agentId}/keys/challenge`, { token: ownerToken });
const challengeSig = b64url(
  await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, new TextEncoder().encode(challenge.body.message)),
);
const registered = await call("POST", `/v1/agents/${agentId}/keys`, {
  token: ownerToken,
  body: { public_key: publicKey, nonce: challenge.body.nonce, signature: challengeSig, label: "e2e" },
});
check("key registers after a valid challenge response", registered.status === 201);

const revisions = await call("GET", `/v1/articles/${articleId}/revisions`, { token: agentToken });
const head = revisions.body.items[0];
const signingInput = [
  "orator-revision-v1",
  articleId,
  head.id,
  head.content_hash,
  head.created_at,
].join("\n");
const signature = b64url(
  await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, new TextEncoder().encode(signingInput)),
);

const started = Date.now();
const published = await call("POST", `/v1/articles/${articleId}/publish`, {
  token: agentToken,
  headers: { "idempotency-key": `pub-${suffix}` },
  body: { revision_id: head.id, signature, signature_key_id: registered.body.id },
});
const elapsed = Date.now() - started;
check("article publishes", published.status === 200, `${elapsed}ms`);
check("the signature verified", published.body?.signed === true);
check("the response says what has not happened yet", published.body?.processing?.sitemap === "pending");

const badSig = await call("POST", `/v1/articles/${articleId}/publish`, {
  token: agentToken,
  headers: { "idempotency-key": `pub-bad-${suffix}` },
  body: { revision_id: head.id, signature: b64url(new Uint8Array(64)), signature_key_id: registered.body.id },
});
check("a forged signature is refused", badSig.status === 422);

// --- reading ----------------------------------------------------------------
const read = await call("GET", `/v1/articles/${articleId}`);
check("published article is readable anonymously", read.status === 200);
check("body comes back from content storage", read.body?.content?.body?.startsWith("# Measuring cold start"));
check("content is labelled untrusted", read.body?.content?.trust === "untrusted");
check("provenance is reported", read.body?.content?.disclosure === "ai_generated");
check("signature state is reported", read.body?.content?.signature_verified === true);

// --- events -----------------------------------------------------------------
const activity = await call("GET", `/v1/articles/${articleId}/activity`);
check(
  "publication appears in public activity",
  activity.body.items.some((e) => e.type === "article.published"),
);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);

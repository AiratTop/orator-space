#!/usr/bin/env node
/**
 * Phase 5 checkpoint (PLAN.md §8): the REST surface and passkey sign-in, end to end.
 *
 * What the unit tests cannot reach is here: the contract as a client actually meets it —
 * status codes, headers, problem documents, the notification an agent has to receive to
 * know it was answered, and a WebAuthn ceremony performed by something holding a private
 * key. Phase 3's signature defect is the standing reason this exists: it had passing unit
 * tests and failed the first time a real sequence ran.
 *
 *   node scripts/e2e-phase5.mjs [apiBase] [webBase]
 */
import { createVirtualAuthenticator } from "./lib/virtual-authenticator.mjs";

const apiBase = process.argv[2] ?? "http://localhost:8787";
const webBase = process.argv[3] ?? "http://localhost:4321";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const section = (name) => console.log(`\n${name}`);

const suffix = Math.random().toString(36).slice(2, 8);
let keys = 0;
const idem = () => `p5-${suffix}-${(keys += 1)}`;

async function api(method, path, { token, body, headers = {}, key } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { "idempotency-key": key } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

console.log(`\nPhase 5 checkpoint — api ${apiBase}, web ${webBase}\n`);

// --- identity ----------------------------------------------------------------
section("Identity (§7, §42, §43)");

const owner = await api("POST", "/v1/humans", { body: { username: `p5-owner-${suffix}` } });
check("a human registers and receives a first token", owner.status === 201 && !!owner.body?.token);
if (owner.status !== 201) {
  console.error("cannot continue:", JSON.stringify(owner.body));
  process.exit(1);
}
const ownerToken = owner.body.token;
const ownerId = owner.body.id;

const dup = await api("POST", "/v1/humans", { body: { username: `p5-owner-${suffix}` } });
check("a taken username is a conflict, not a second account", dup.status === 409);

const agent = await api("POST", "/v1/agents", {
  token: ownerToken,
  body: { username: `p5-agent-${suffix}`, model: "claude-opus-5", provider: "anthropic" },
});
check("an agent is created under that human", agent.status === 201);
const agentId = agent.body.principal_id;

const critic = await api("POST", "/v1/agents", {
  token: ownerToken,
  body: { username: `p5-critic-${suffix}` },
});
const criticId = critic.body.principal_id;

const tokenKey = idem();
const issued = await api("POST", "/v1/tokens", {
  token: ownerToken,
  key: tokenKey,
  body: { principal_id: agentId, name: "agent" },
});
check("a scoped token is issued for the agent", issued.status === 201 && !!issued.body?.token);
const agentToken = issued.body.token;

const reissued = await api("POST", "/v1/tokens", {
  token: ownerToken,
  key: tokenKey,
  body: { principal_id: agentId, name: "agent" },
});
check(
  "replaying that key returns the same token rather than minting a second",
  reissued.body?.id === issued.body?.id,
  `${reissued.body?.id} vs ${issued.body?.id}`,
);

const noKey = await api("POST", "/v1/tokens", {
  token: ownerToken,
  body: { principal_id: agentId, name: "agent" },
});
check("issuing without an idempotency key is refused (§34.1)", noKey.status === 422);

const criticToken = (
  await api("POST", "/v1/tokens", {
    token: ownerToken,
    key: idem(),
    body: { principal_id: criticId, name: "critic" },
  })
).body.token;

/*
 * The fixture bio says something the page does not.
 *
 * It used to read "Runs two agents.", which the profile now states on its own — §7.2's block
 * counts them and links to each. Two lines saying one thing, one of them stale the moment a
 * third agent is registered. A bio is the account's own words and the platform never edits
 * them, so what had to change is the test data rather than the page.
 */
const BIO = "Publishing notes on latency, mostly.";
const profile = await api("PATCH", `/v1/principals/${ownerId}`, {
  token: ownerToken,
  body: { display_name: "The Owner", bio: BIO },
});
check("a profile is edited by its own principal", profile.status === 200 && profile.body?.bio === BIO);

const foreign = await api("PATCH", `/v1/principals/${criticId}`, {
  token: agentToken,
  body: { display_name: "Not mine" },
});
check("a sibling agent cannot edit another's profile (§43.2)", foreign.status === 403);

const byName = await api("GET", `/v1/principals/by-username/p5-agent-${suffix}`);
check("a principal is readable by username, without a key", byName.status === 200 && byName.body?.kind === "agent");
check("an agent's accountable owner is public (§7.2)", byName.body?.owner_principal_id === ownerId);

// --- publishing ----------------------------------------------------------------
section("Publishing (§16, §23, §34)");

/*
 * The body carries this run's suffix, and the search below looks for that.
 *
 * It used to search for "invocations", a word every previous run had also published. Ranked
 * search returns one page (§38.1), so as the corpus grows the article this run just
 * published stops appearing in the top results and the check fails — not because indexing
 * broke, but because the term stopped identifying anything. A checkpoint that decays with
 * the size of the database is one that will be re-run until it passes.
 */
const BODY = `# Cold start across runtimes\n\nA hundred invocations per runtime, same payload. Run ${suffix}.\n`;

const created = await api("POST", "/v1/articles", {
  token: agentToken,
  key: idem(),
  body: { title: "Cold start across runtimes", content: BODY },
});
check("an article is created", created.status === 201);
const articleId = created.body.id;
const firstRevision = created.body.revision_id;

const stale = await api("POST", `/v1/articles/${articleId}/revisions`, {
  token: agentToken,
  key: idem(),
  headers: { "if-match": '"06G20000000000000000000000"' },
  body: { title: "Cold start across runtimes", content: `${BODY}\nA second paragraph.\n` },
});
check("a stale If-Match is refused with 412 (§34.3)", stale.status === 412);

const revision = await api("POST", `/v1/articles/${articleId}/revisions`, {
  token: agentToken,
  key: idem(),
  headers: { "if-match": `"${firstRevision}"` },
  body: { title: "Cold start across runtimes", content: `${BODY}\nA second paragraph.\n` },
});
check("a revision is created with the current If-Match", revision.status === 201);

const patched = await api("PATCH", `/v1/articles/${articleId}`, {
  token: agentToken,
  body: { language: "en-GB" },
});
check("metadata patches", patched.status === 200);

const relabel = await api("PATCH", `/v1/articles/${articleId}`, {
  token: agentToken,
  body: { authorship_disclosure: "human_authored" },
});
check("an agent cannot relabel its output as human-authored (§10)", relabel.status === 422);

const published = await api("POST", `/v1/articles/${articleId}/publish`, { token: agentToken, key: idem() });
check("the article publishes", published.status === 200);
check(
  "the response says what has not happened yet (§34.4)",
  published.body?.processing?.search_indexed === false,
);

const read = await api("GET", `/v1/articles/${articleId}`);
check("it reads anonymously", read.status === 200);
check("the body is labelled untrusted (§58.2)", read.body?.content?.trust === "untrusted");

/*
 * §16.3 — the public list is the published versions, and this used to be every revision.
 *
 * The article above has two revisions and one of them was published; a reader sees one, and
 * the author sees both. The assertion here was `>= 2` anonymously, which is to say it
 * asserted the leak: the endpoint checked nothing at all, so the draft written a moment ago
 * was public the moment it existed.
 */
const revisions = await api("GET", `/v1/articles/${articleId}/revisions`);
check(
  "a reader sees the published versions and no drafts",
  revisions.body.items.length >= 1 &&
    revisions.body.items.every((item) => item.published_at !== null),
  `${revisions.body.items.length} listed`,
);

const authorRevisions = await api("GET", `/v1/articles/${articleId}/revisions`, { token: agentToken });
check(
  "and the author sees their own drafts as well",
  authorRevisions.body.items.length > revisions.body.items.length,
  `${authorRevisions.body.items.length} to the author, ${revisions.body.items.length} to a reader`,
);

const oneRevision = await api("GET", `/v1/articles/${articleId}/revisions/${firstRevision}`);
check("one revision is readable, body included", oneRevision.status === 200 && !!oneRevision.body?.content?.body);

// --- social ----------------------------------------------------------------------
section("Social (§17, §18, §19, §20)");

const comment = await api("POST", `/v1/articles/${articleId}/comments`, {
  token: criticToken,
  key: idem(),
  body: { content: "The baseline measures the wrong thing.", stance: "challenges" },
});
check("a second agent comments", comment.status === 201);
const commentId = comment.body.id;

const listed = await api("GET", `/v1/articles/${articleId}/comments`);
check("the comment is listed", listed.body?.items?.some((entry) => entry.id === commentId));
check("a comment body is labelled untrusted too", listed.body?.items?.[0]?.content?.trust === "untrusted");

const reply = await api("POST", `/v1/comments/${commentId}/replies`, {
  token: agentToken,
  key: idem(),
  body: { content: "Here is why it does not.", stance: "disagrees" },
});
check("the author replies", reply.status === 201 && reply.body?.depth === 1);

const response = await api("POST", "/v1/articles", {
  token: criticToken,
  key: idem(),
  body: { title: "A different baseline", content: "# A different baseline\n\nMeasured per workload.\n" },
});
await api("POST", `/v1/articles/${response.body.id}/publish`, { token: criticToken, key: idem() });

const edge = await api("POST", "/v1/edges", {
  token: criticToken,
  key: idem(),
  body: { src_article_id: response.body.id, kind: "challenges", dst_article_id: articleId },
});
check("an edge is asserted by the source article's author", edge.status === 201);

const stolen = await api("POST", "/v1/edges", {
  token: agentToken,
  key: idem(),
  body: { src_article_id: response.body.id, kind: "cites", dst_article_id: articleId },
});
check("nobody else may assert an edge from that article (§18)", stolen.status === 403);

const edges = await api("GET", `/v1/articles/${articleId}/edges`);
check("edges into the article are listed", edges.body?.items?.length >= 1);

const followed = await api("POST", "/v1/follows", { token: criticToken, body: { principal_id: agentId } });
check("a follow is recorded", followed.status === 201);
const again = await api("POST", "/v1/follows", { token: criticToken, body: { principal_id: agentId } });
check("following twice is the same state, not a conflict", again.status === 201);

// --- events ----------------------------------------------------------------------
section("Events (§20) — how an agent learns it was answered");

const events = await api("GET", "/v1/events", { token: agentToken });
check("the author's notifications are readable", events.status === 200);
const types = (events.body?.items ?? []).map((entry) => entry.type);
check("the comment produced a notification", types.includes("comment.created"), types.join(", "));
check("the challenge produced one too", types.includes("article.challenged"), types.join(", "));
check("the follow produced one too", types.includes("principal.followed"), types.join(", "));

const filtered = await api("GET", "/v1/events?type=comment.created", { token: agentToken });
check(
  "the type filter narrows the feed",
  (filtered.body?.items ?? []).every((entry) => entry.type === "comment.created"),
);

const anonymous = await api("GET", "/v1/events");
check("notifications are not public", anonymous.status === 401);

const criticEvents = await api("GET", "/v1/events", { token: criticToken });
check(
  "the reply reached the commenter, not the article's author",
  (criticEvents.body?.items ?? []).some((entry) => entry.type === "comment.replied"),
);

// --- discovery -------------------------------------------------------------------
section("Discovery (§37, §38)");

const feed = await api("GET", "/v1/feed?limit=5");
check("the feed lists published articles", feed.status === 200 && feed.body?.items?.length >= 1);
check("the newest is first", feed.body?.items?.[0]?.published_at >= feed.body?.items?.at(-1)?.published_at);

/**
 * Indexing is asynchronous by design (§38.1), so this waits rather than asserting once.
 *
 * The wait is the point: §34.4 tells an agent that a published article is readable at once
 * and searchable shortly after, and a check that passed immediately would mean the index
 * was being written inside the publishing transaction — which is the arrangement §38.1
 * exists to prevent.
 */
/*
 * The budget is set by `max_batch_timeout`, not by a guess.
 *
 * A single published article is one message on a queue whose consumer waits up to 10
 * seconds for a batch to fill before running (`apps/edge/wrangler.jsonc`). At 20 attempts
 * of 500 ms this loop gave up at exactly that boundary, so it passed or failed on which
 * side of the batch window the publish landed — and a checkpoint that fails on a coin toss
 * is one people learn to re-run rather than read. Forty attempts is two batch windows.
 */
async function searchUntilFound(term, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await api("GET", `/v1/search?q=${encodeURIComponent(term)}`);
    if (result.status !== 200) return result;
    if ((result.body?.articles ?? []).some((entry) => entry.id === articleId)) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return api("GET", `/v1/search?q=${encodeURIComponent(term)}`);
}

const search = await searchUntilFound(`invocations ${suffix}`);
check("search answers", search.status === 200, JSON.stringify(search.body).slice(0, 120));
check(
  "the published article turns up once the event pipeline has run (§34.4)",
  (search.body?.articles ?? []).some((entry) => entry.id === articleId),
);
check("ranked results carry no cursor (§38.1)", search.body?.next_cursor === null);

const injected = await api("GET", `/v1/search?q=${encodeURIComponent('cold" OR "x NEAR/2 y')}`);
check("an FTS operator in the query is data, not syntax", injected.status === 200);

const empty = await api("GET", "/v1/search?q=");
check("an empty query is refused rather than returning everything", empty.status === 422);

const principals = await api("GET", `/v1/search?type=principals&q=p5-agent-${suffix}`);
check("principals are searchable by exact name", principals.body?.principals?.length === 1);

const topics = await api("GET", "/v1/topics");
check("the topic vocabulary is readable", topics.status === 200 && Array.isArray(topics.body?.items));

// --- errors ----------------------------------------------------------------------
section("The error contract (§45)");

const unauthorised = await api("POST", "/v1/articles", { key: idem(), body: { title: "x", content: "y" } });
check("an unauthenticated write is 401", unauthorised.status === 401);
check(
  "it is a problem document",
  unauthorised.headers.get("content-type")?.includes("application/problem+json"),
);
check("with a stable type URI", unauthorised.body?.type === "https://orator.space/errors/unauthenticated");
check("and the request id, so a caller can quote it", !!unauthorised.body?.request_id);

const invalid = await api("POST", "/v1/articles", { token: agentToken, key: idem(), body: { title: "" } });
check("a validation error is 422", invalid.status === 422);
check(
  "and names the offending field, because the caller is usually a model (§45.1)",
  Array.isArray(invalid.body?.errors) && invalid.body.errors.some((e) => e.field === "title"),
);

const missing = await api("GET", "/v1/articles/06G0000000000000000000000X");
check("an unknown article is 404", missing.status === 404);

const notAnId = await api("GET", "/v1/articles/nonsense");
check("a malformed id is 404, not a 500", notAnId.status === 404);

// --- removal ----------------------------------------------------------------------
section("Removal and erasure (§23)");

const doomed = await api("POST", "/v1/articles", {
  token: agentToken,
  key: idem(),
  body: { title: "To be withdrawn", content: "# To be withdrawn\n\nA body.\n" },
});
await api("POST", `/v1/articles/${doomed.body.id}/publish`, { token: agentToken, key: idem() });

const removed = await api("DELETE", `/v1/articles/${doomed.body.id}`, { token: agentToken });
check("an article is removed", removed.status === 200);

const tombstone = await api("GET", `/v1/articles/${doomed.body.id}`);
check("it answers 410, not 404 — the id existed and citations resolve (§23.2)", tombstone.status === 410);

const eraseByAgent = await api("POST", `/v1/articles/${doomed.body.id}/erase`, {
  token: agentToken,
  body: { confirm: "erase" },
});
check("an agent may not erase: that is its owner's act (§23.3)", eraseByAgent.status === 403);

const unconfirmed = await api("POST", `/v1/articles/${doomed.body.id}/erase`, {
  token: ownerToken,
  body: { confirm: "yes" },
});
check("erasure must be confirmed verbatim", unconfirmed.status === 422);

const erased = await api("POST", `/v1/articles/${doomed.body.id}/erase`, {
  token: ownerToken,
  body: { confirm: "erase", reason: "checkpoint" },
});
check("the owner erases it", erased.status === 200 && erased.body?.revisions >= 1);

// --- moderation --------------------------------------------------------------------
section("Moderation (§61)");

const report = await api("POST", "/v1/reports", {
  body: { target_type: "article", target_id: articleId, category: "spam", details: "Checkpoint." },
});
check("anyone may report, with no account at all (§61.2)", report.status === 201);

const phantom = await api("POST", "/v1/reports", {
  body: { target_type: "article", target_id: "06G0000000000000000000000X", category: "spam" },
});
check("a report about nothing is refused", phantom.status === 404);

// --- media -----------------------------------------------------------------------
section("Media (\u00a721.1, \u00a757.4, ADR 0005)");

/** The media host is the API host with its first label swapped (\u00a757.4). */
const mediaBase = (() => {
  const url = new URL(apiBase);
  url.hostname = url.hostname.replace(/^api/, "media");
  return url.origin;
})();

const png = (size) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < size; i++) bytes[i] = i & 0xff;
  return bytes;
};

/**
 * Real HTTP, not a synthetic Request.
 *
 * The design turns on `Content-Length` being present and exact, and that is a property of
 * what a client and the platform put on the wire \u2014 `fetch` will use chunked encoding for
 * some body types, and an in-process test cannot tell the difference.
 */
async function putBytes(id, bytes, { token, headers = {} } = {}) {
  const response = await fetch(`${apiBase}/v1/media/${id}/content`, {
    method: "PUT",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-length": String(bytes.byteLength),
      ...headers,
    },
    body: bytes,
    duplex: "half",
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

const reserved = await api("POST", "/v1/media", {
  token: agentToken,
  key: idem(),
  body: { kind: "image", alt_text: "A chart of cold-start times." },
});
check("a media record is reserved", reserved.status === 201 && reserved.body?.status === "pending");
check("it holds nothing yet", reserved.body?.content_type === null && reserved.body?.url === null);
check("it says where to send the bytes", reserved.body?.upload_url?.endsWith(`/v1/media/${reserved.body?.id}/content`));

const uploaded = await putBytes(reserved.body.id, png(4096), { token: agentToken });
check("the bytes upload and the record finishes in the same call", uploaded.status === 200);
check("the type is sniffed, not taken from a header", uploaded.body?.content_type === "image/png");
check("the size is what actually arrived", uploaded.body?.byte_size === 4096);
check("a sha256 was taken from the stream", /^[0-9a-f]{64}$/.test(uploaded.body?.checksum_sha256 ?? ""));
check("a ready record has a public address on the media host", uploaded.body?.url === `${mediaBase}/${uploaded.body?.id}/original`);

const replayed = await putBytes(reserved.body.id, png(4096), { token: agentToken });
check("a record that already has bytes refuses more (\u00a716.1)", replayed.status === 409);

const served = await fetch(`${mediaBase}/${uploaded.body.id}/original`);
const servedBytes = new Uint8Array(await served.arrayBuffer());
check("the media host serves it", served.status === 200);
check("the bytes come back unchanged", servedBytes.byteLength === 4096 && servedBytes[4095] === (4095 & 0xff));
check("served with nosniff", served.headers.get("x-content-type-options") === "nosniff");
check("served under a CSP that permits nothing", served.headers.get("content-security-policy") === "default-src 'none'; sandbox");
check("served immutable, since the bytes can never change", (served.headers.get("cache-control") ?? "").includes("immutable"));

if (mediaBase === apiBase) {
  // Locally both surfaces answer on localhost, so there is no second origin to be refused
  // from. Skipped loudly rather than silently passing: a check that cannot fail is worse
  // than no check, because it reads like one that did.
  check("the API host does not serve media (\u00a757.4)", true, "skipped: one origin locally");
} else {
  const wrongHost = await fetch(`${apiBase}/${uploaded.body.id}/original`);
  check("the API host does not serve media (\u00a757.4)", wrongHost.status === 404);
}

const svgRecord = await api("POST", "/v1/media", { token: agentToken, key: idem(), body: { kind: "image" } });
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
const svgUpload = await putBytes(svgRecord.body.id, svg, { token: agentToken });
check("an SVG is refused by name (ADR 0005)", svgUpload.status === 422 && /SVG/.test(svgUpload.body?.title ?? ""));

const svgAfter = await api("GET", `/v1/media/${svgRecord.body.id}`, { token: agentToken });
check("the refused record is rejected, not left pending for the sweeper", svgAfter.body?.status === "rejected");
check("and the media host will not serve it", (await fetch(`${mediaBase}/${svgRecord.body.id}/original`)).status === 404);

const bigRecord = await api("POST", "/v1/media", { token: agentToken, key: idem(), body: { kind: "image" } });

/**
 * The oversize refusal is not checked here, and that is a finding rather than a gap.
 *
 * It cannot be provoked cheaply. A client cannot lie about `Content-Length` — `fetch`
 * refuses to send one that disagrees with its body — and a stalled stream never gets an
 * answer, because Cloudflare delivers the Worker's response only once the request body has
 * been consumed. Measured on staging: 50 MB + 1 returns 413 after 10.8 s, having sent the
 * whole file. So the only faithful check costs 50 MB per run.
 *
 * The integration test asserts the 413 in-process, §21.1 records the measurement, and the
 * limit is published in the API description because that is the only place checking it is
 * cheap. What is asserted here instead is the rest of what that record can and cannot do.
 */
const untokened = await putBytes(bigRecord.body.id, png(64));
check("bytes without a token are refused", untokened.status === 401);

const pendingRead = await api("GET", `/v1/media/${bigRecord.body.id}`);
check("a record with no bytes is not public", pendingRead.status === 404);

// --- passkeys ------------------------------------------------------------------------
section("Passkey sign-in (§42.2, §9.1, ADR 0004)");

const webOrigin = new URL(webBase).origin;
const rpId = new URL(webBase).hostname;
const authenticator = await createVirtualAuthenticator({ rpId, origin: webOrigin });

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

async function web(path, { body, token } = {}) {
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
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

// The bootstrap: a person who has just registered holds a token and nothing else.
const regOptions = await web("/auth/passkey/register-options", { token: ownerToken });
check("registration options are issued against the first token (§42.2)", regOptions.status === 200);
check("the challenge cookie is set", cookies.has("orator_challenge"));
check(
  "a discoverable credential is requested, so signing in needs no username",
  regOptions.body?.authenticatorSelection?.residentKey === "required",
);

if (regOptions.status === 200) {
  const attestation = await authenticator.register(regOptions.body.challenge);
  const registered = await web("/auth/passkey/register", { token: ownerToken, body: attestation });
  check("the ceremony verifies and the passkey is stored", registered.status === 201, JSON.stringify(registered.body));
  check("the challenge cookie is cleared afterwards", !cookies.has("orator_challenge"));

  const loginOptions = await web("/auth/passkey/login-options");
  check("sign-in options are issued to an anonymous caller", loginOptions.status === 200);
  check(
    "and disclose nothing about who is registered",
    (loginOptions.body?.allowCredentials ?? []).length === 0,
  );

  const assertion = await authenticator.authenticate(loginOptions.body.challenge);
  const signedIn = await web("/auth/passkey/login", { body: assertion });
  check("the assertion verifies and a session begins", signedIn.status === 200, JSON.stringify(signedIn.body));
  check("as the right person", signedIn.body?.username === `p5-owner-${suffix}`);
  check("a session cookie is set", cookies.has("orator_session"));

  const sessionValue = cookies.get("orator_session");

  // The rule §9.1 exists for.
  const asCookie = await fetch(`${apiBase}/v1/tokens`, {
    headers: { cookie: `orator_session=${sessionValue}` },
  });
  check("the API does not accept that session cookie (§9.1)", asCookie.status === 401);

  const asBearer = await fetch(`${apiBase}/v1/tokens`, {
    headers: { authorization: `Bearer ${decodeURIComponent(sessionValue)}` },
  });
  check("nor the session value presented as a bearer token", asBearer.status === 401);

  // A replayed assertion: the challenge cookie is gone, so it has nothing to verify against.
  const replay = await web("/auth/passkey/login", { body: assertion });
  check("a replayed assertion is refused once the challenge is spent", replay.status === 401);

  /**
   * A cross-site POST to the sign-out form is refused before it reaches the handler.
   *
   * Astro checks the Origin header on form submissions; without it, any page on the
   * internet could sign a reader out by submitting a hidden form. Asserted here because it
   * is a real defence that arrived by default — and a default nobody has watched work is
   * an assumption.
   */
  const forged = await fetch(`${webBase}/auth/signout`, {
    method: "POST",
    headers: {
      cookie: `orator_session=${sessionValue}`,
      origin: "https://evil.test",
      "content-type": "application/x-www-form-urlencoded",
    },
    redirect: "manual",
  });
  check("a sign-out submitted from another origin is refused", forged.status === 403);

  const signedOut = await fetch(`${webBase}/auth/signout`, {
    method: "POST",
    headers: {
      cookie: `orator_session=${sessionValue}`,
      origin: webOrigin,
      "content-type": "application/x-www-form-urlencoded",
    },
    redirect: "manual",
  });
  check("signing out from the site itself redirects", signedOut.status === 303);

  const afterSignOut = await fetch(`${webBase}/signin`, {
    headers: { cookie: `orator_session=${sessionValue}` },
  });
  const signInPage = await afterSignOut.text();
  check("the revoked session no longer signs anyone in", signInPage.includes("Sign in with a passkey"));
}

// --- creating an account from a browser ------------------------------------------------
section("Signing up (§9, §7.3, §42.2)");

/*
 * The bug this covers: the site had no way to register at all.
 *
 * `/signin` offered one button, wired to `navigator.credentials.get`, which asks for a
 * passkey that already exists — so a password manager was asked to find one, correctly found
 * none, and there was no second button. Registration existed only on the API, which returns a
 * token and is the wrong shape for a browser (§9.1).
 */
cookies.clear();

/*
 * A second authenticator, because a new person arrives with their own device.
 *
 * The first attempt at this section reused the one above and was refused with "that passkey
 * already belongs to an account" — which is the duplicate guard working, and is asserted
 * deliberately further down rather than tripped over.
 */
const newDevice = await createVirtualAuthenticator({ rpId, origin: webOrigin });

const claimed = `signup-${suffix}`;
const abandoned = `abandoned-${suffix}`;
const profileStatus = async (username) =>
  (await fetch(`${webBase}/@${username}`, { redirect: "manual" })).status;

const takenName = await web("/auth/passkey/signup-options", { body: { username: `p5-owner-${suffix}` } });
check("a taken username is refused before any ceremony begins", takenName.status === 409, `${takenName.status}`);
check(
  // §45 — a stable type URI per class of error. This answered `validation-failed` until a
  // conflict became reachable, which would have taught a client to match the wrong one.
  "and the problem document names the conflict",
  (takenName.body?.type ?? "").endsWith("/conflict"),
  takenName.body?.type ?? "",
);

const tooShort = await web("/auth/passkey/signup-options", { body: { username: "ab" } });
check("a name that is not a name is refused with a reason (§7.3)", tooShort.status === 400 && tooShort.body?.detail === "too-short");

const started = await web("/auth/passkey/signup-options", { body: { username: claimed } });
check("options are issued for a free name, to an anonymous caller", started.status === 200, `${started.status}`);
check("the challenge cookie carries the pending sign-up", cookies.has("orator_challenge"));
check(
  "a discoverable credential is requested, so the next sign-in needs no username",
  started.body?.authenticatorSelection?.residentKey === "required",
);

/*
 * The property the whole flow is arranged around (§7.3).
 *
 * §7.3 never reassigns a username, so an account created before its passkey exists is a name
 * lost for good the first time somebody's phone locks mid-ceremony. Nothing is written until
 * there is a verified credential to write with it.
 */
check("no account exists yet, halfway through", (await profileStatus(claimed)) === 404);

if (started.status === 200) {
  const attestation = await newDevice.register(started.body.challenge);
  const created = await web("/auth/passkey/signup", { body: { credential: attestation } });
  check("the account and its passkey are created together", created.status === 200, JSON.stringify(created.body));
  check("and the caller is signed in already", cookies.has("orator_session"));
  check("the challenge cookie is cleared afterwards", !cookies.has("orator_challenge"));
  check("and the profile now resolves", (await profileStatus(claimed)) === 200);
}

/*
 * One passkey, one account (§9.1).
 *
 * `excludeCredentials` is empty on the way out — there is no account yet to exclude anything
 * for — so an authenticator holding a passkey for this site will happily mint a second. The
 * server refuses on the way back, and says the useful thing rather than creating a second
 * identity behind one credential.
 */
const secondAccount = await web("/auth/passkey/signup-options", { body: { username: `second-${suffix}` } });
if (secondAccount.status === 200) {
  const reused = await newDevice.register(secondAccount.body.challenge);
  const refused = await web("/auth/passkey/signup", { body: { credential: reused } });
  check("a passkey that already has an account cannot open a second", refused.status === 409, `${refused.status}`);
  check("and the name it tried to claim is still free", (await profileStatus(`second-${suffix}`)) === 404);
}

// An abandoned ceremony costs nothing — which is the point of committing once at the end.
cookies.clear();
await web("/auth/passkey/signup-options", { body: { username: abandoned } });
check("an abandoned sign-up leaves no account behind", (await profileStatus(abandoned)) === 404);
const retry = await web("/auth/passkey/signup-options", { body: { username: abandoned } });
check("and the name is still free to claim", retry.status === 200, `${retry.status}`);

// The two ceremonies share a cookie name and an envelope, and must not complete each other's.
cookies.clear();
const crossed = await web("/auth/passkey/login-options");
if (crossed.status === 200) {
  const wrongWay = await web("/auth/passkey/signup", { body: { credential: {} } });
  check("a sign-in challenge cannot finish a sign-up", wrongWay.status === 400, `${wrongWay.status}`);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);

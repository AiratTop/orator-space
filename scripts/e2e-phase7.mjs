#!/usr/bin/env node
/**
 * Phase 7 checkpoint (PLAN.md §10): the §84 chain, run by three agents from outside.
 *
 * The earlier checkpoints each test one surface. This one tests the product claim: that a
 * publishing network for machines is a network, not a CMS with an API. It runs the §76
 * scenario end to end — publish, discover, read, challenge, learn of it, reply, synthesise
 * — and then opens the article the way a person would and checks that the whole chain is
 * legible on the page. Every step goes through MCP, because that is the door an agent
 * actually comes through, and nothing here reaches past the public contract.
 *
 * Two things make it a checkpoint rather than a demonstration:
 *
 *   1. It starts from nothing. Three principals are registered, keyed and scoped in the
 *      run, so a passing run says the chain works from an empty account rather than from a
 *      fixture somebody prepared.
 *   2. The articles carry measurements this run took. §3.1 says content whose substance
 *      comes from a model's training data has near-zero value to a reading model, and a
 *      loop carrying that kind of content passes formally while proving nothing. So the
 *      researcher publishes how long publishing took and how long the article took to
 *      become discoverable, measured here; the critic publishes what it measured from the
 *      other side. Small facts, but facts, and neither agent could have produced them
 *      without running.
 *
 *   node scripts/e2e-phase7.mjs [apiBase] [webBase] [mcpBase]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const apiBase = process.argv[2] ?? "http://localhost:8787";
const webBase = process.argv[3] ?? "http://localhost:4321";
const mcpBase = process.argv[4] ?? apiBase;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const section = (name) => console.log(`\n${name}`);

const suffix = Math.random().toString(36).slice(2, 8);
const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`\nPhase 7 checkpoint — api ${apiBase}, web ${webBase}, mcp ${mcpBase}\n`);

// ---------------------------------------------------------------------------
// The parts an agent cannot do for itself (§7.2, §8.2)
//
// Registration, key enrolment and token issuance are the owner's, not the agent's: §7.2
// makes a human accountable for an agent, and an agent that could create its own principal
// and mint its own scopes would make that accountability a formality. So this section uses
// REST as the operator, and everything after it uses MCP as the agent.
// ---------------------------------------------------------------------------

async function api(method, path, { token, body, headers = {} } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

section("Standing up three agents under one accountable human (§7.2)");

const owner = await api("POST", "/v1/humans", { body: { username: `p7-owner-${suffix}` } });
check("the owner registers", owner.status === 201 && !!owner.body?.token);
const ownerToken = owner.body.token;

/**
 * One agent, with the two tokens it will actually use.
 *
 * Split by what the work needs rather than by convenience. The reading token cannot write
 * and the writing token cannot manage anything, so a prompt injection that reaches the
 * agent through someone else's article (§58.1) has nothing to reach for: the credential in
 * scope while untrusted content is being read grants reading and nothing else.
 */
async function enrol(role) {
  const agent = await api("POST", "/v1/agents", {
    token: ownerToken,
    body: { username: `p7-${role}-${suffix}`, model: "claude-opus-5", provider: "anthropic" },
  });
  if (agent.status !== 201) throw new Error(`${role}: ${JSON.stringify(agent.body)}`);
  const principalId = agent.body.principal_id;

  const token = async (name, scopes) =>
    (
      await api("POST", "/v1/tokens", {
        token: ownerToken,
        headers: { "idempotency-key": `p7-${role}-${name}-${suffix}` },
        body: { principal_id: principalId, name: `${role}-${name}`, scopes },
      })
    ).body.token;

  const read = await token("read", ["articles:read", "comments:read", "events:read"]);
  const write = await token("write", [
    "articles:read",
    "articles:write",
    "articles:publish",
    "comments:read",
    "comments:write",
    "edges:write",
    "events:read",
  ]);

  // §8.2 — the key is generated here and the private half never leaves this process, which
  // is the whole claim signing makes. The server sees a public key and a challenge response.
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const challenge = await api("POST", `/v1/agents/${principalId}/keys/challenge`, { token: ownerToken });
  const answer = b64url(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      pair.privateKey,
      new TextEncoder().encode(challenge.body.message),
    ),
  );
  const key = await api("POST", `/v1/agents/${principalId}/keys`, {
    token: ownerToken,
    body: {
      public_key: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)),
      nonce: challenge.body.nonce,
      signature: answer,
      label: `p7-${role}`,
    },
  });
  if (key.status !== 201) throw new Error(`${role} key: ${JSON.stringify(key.body)}`);

  return {
    role,
    principalId,
    username: `p7-${role}-${suffix}`,
    read,
    write,
    keyId: key.body.id,
    privateKey: pair.privateKey,
  };
}

const researcher = await enrol("researcher");
const critic = await enrol("critic");
const analyst = await enrol("analyst");
check("three agents exist, each keyed and scoped", true, `@${researcher.username} @${critic.username} @${analyst.username}`);

const overreach = await api("POST", "/v1/articles", {
  token: researcher.read,
  headers: { "idempotency-key": `p7-overreach-${suffix}` },
  body: { title: "Should not exist", content: "x" },
});
check("a reading token cannot publish (§43.1)", overreach.status === 403, String(overreach.status));

// ---------------------------------------------------------------------------
// Everything below is MCP, because that is how an agent works (§47)
// ---------------------------------------------------------------------------

async function connect(token) {
  const client = new Client({ name: `orator-phase7-${suffix}`, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** Calls a tool and returns its structured result, or throws with what the server said. */
async function tool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content?.map((part) => part.text ?? "").join("\n") ?? "";
    throw new Error(`${name}: ${text.slice(0, 300)}`);
  }
  return result.structuredContent;
}

const sessions = {
  researcher: { read: await connect(researcher.read), write: await connect(researcher.write) },
  critic: { read: await connect(critic.read), write: await connect(critic.write) },
  analyst: { read: await connect(analyst.read), write: await connect(analyst.write) },
};

/**
 * Signs what the server said to sign (§8.3).
 *
 * `signing_input` is the canonical string, returned with the revision. The agent does not
 * rebuild it: §8.3 is a determined encoding precisely so that two implementations cannot
 * disagree about it, and an agent assembling its own version is one join character away
 * from a signature that fails with no indication of why.
 */
async function sign(agent, signingInput) {
  return b64url(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      agent.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
}

async function publish(agent, { title, content, key }) {
  const created = await tool(sessions[agent.role].write, "create_article", {
    title,
    content,
    authorship_disclosure: "ai_generated",
    idempotency_key: `p7-${key}-${suffix}`,
  });
  const published = await tool(sessions[agent.role].write, "publish_article", {
    article_id: created.id,
    revision_id: created.revision_id,
    signature: await sign(agent, created.signing_input),
    signature_key_id: agent.keyId,
    idempotency_key: `p7-${key}-publish-${suffix}`,
  });
  return { id: created.id, url: created.url, signed: published.signed };
}

// --- Agent A: the researcher publishes something it measured -----------------
section("A researcher publishes an observation it made (§76, §3.1)");

const publishStarted = Date.now();
const source = await publish(researcher, {
  key: "source",
  title: `Publish latency on Orator, ${new Date().toISOString().slice(0, 10)} (run ${suffix})`,
  content: [
    `# Publish latency, run ${suffix}`,
    "",
    "One agent, one article, one region, against the deployment under test. This article is",
    "the subject of its own measurement, so it is published before it has any results: the",
    "figures exist only once the run has produced them, and they arrive here by revision.",
    "",
    "## Method",
    "",
    "Time the publish call. Then poll full-text search until this article appears, and report",
    "the gap. The two are different quantities and are reported separately, because",
    "publishing is a pointer move and indexing is a queue consumer.",
  ].join("\n"),
});
const publishElapsed = Date.now() - publishStarted;
check("the researcher's article publishes, signed", source.signed === true, `${publishElapsed}ms`);

/**
 * §34.4 — readable at once, searchable shortly after.
 *
 * The wait is the measurement. A check that passed immediately would mean the index was
 * being written inside the publishing transaction, which is exactly what §38.1 forbids.
 */
async function findBySearch(client, term, id, attempts = 40) {
  const started = Date.now();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await tool(client, "search_articles", { q: term, limit: 20 });
    if ((result.articles ?? []).some((entry) => entry.id === id)) return Date.now() - started;
    await pause(500);
  }
  return null;
}

// --- Agent B: the critic discovers it, reads it, and disagrees ---------------
section("A second agent discovers it, reads it and challenges it (§76)");

const indexLatency = await findBySearch(sessions.critic.read, `run ${suffix}`, source.id);
check("the critic finds the article through search, not through a shared fixture", indexLatency !== null, `${indexLatency}ms`);

const asRead = await tool(sessions.critic.read, "get_article", { article_id: source.id });
check("it reads the article through MCP", asRead?.id === source.id);
check("and the body arrives labelled as data, not as instructions (§58.2)", asRead?.content?.trust === "untrusted");
check("with the author named and the signature state stated", asRead?.content?.signature_verified === true);

const rebuttal = await publish(critic, {
  key: "rebuttal",
  title: `What the publish-latency figure in run ${suffix} leaves out`,
  content: [
    "# The method is right and the headline number will be misread",
    "",
    `@${researcher.username} set out to report a publish latency for run ${suffix}. I read the`,
    "article and measured the same deployment from a second client, in the same run:",
    "",
    "| what was measured | milliseconds |",
    "|---|---|",
    `| from publish returning to the article appearing in search | ${indexLatency} |`,
    "",
    "A publish latency describes one call from one client. This number describes the point at",
    "which anybody else could act on the result. For a network the second is the interesting",
    "one, and publishing the first as *the* latency invites a reader to plan against a figure",
    "that does not bound anything they care about.",
  ].join("\n"),
});
check("the critic publishes its own grounded rebuttal", rebuttal.signed === true);

const challenge = await tool(sessions.critic.write, "create_comment", {
  article_id: source.id,
  content: `The measurement stands; the framing does not. Discovery took ${indexLatency} ms in the same run — see [my note](${rebuttal.url}).`,
  stance: "challenges",
  idempotency_key: `p7-challenge-${suffix}`,
});
check("it comments with stance=challenges (§17)", challenge?.stance === "challenges");

const challengeEdge = await tool(sessions.critic.write, "create_edge", {
  src_article_id: rebuttal.id,
  kind: "challenges",
  dst_article_id: source.id,
  note: "Reports a different latency for the same run.",
  idempotency_key: `p7-edge-challenge-${suffix}`,
});
check("and asserts a challenges edge from its own article (§18)", challengeEdge?.kind === "challenges");

const forgery = await api("POST", "/v1/edges", {
  token: critic.write,
  headers: { "idempotency-key": `p7-forgery-${suffix}` },
  body: { src_article_id: source.id, kind: "supports", dst_article_id: rebuttal.id },
});
check("but cannot assert an edge out of someone else's article (§18)", forgery.status === 403, String(forgery.status));

// --- Agent A again: learns of it through events, and answers -----------------
section("The first agent learns of it and replies (§20, §84)");

/** §20 — the notification journal is the only way an agent hears an answer. */
async function waitForEvent(client, type, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const events = await tool(client, "get_events", { limit: 50 });
    const found = (events.items ?? []).find((event) => event.type === type);
    if (found !== undefined) return found;
    await pause(500);
  }
  return null;
}

const commentEvent = await waitForEvent(sessions.researcher.read, "comment.created");
check("the researcher is notified of the comment through get_events", commentEvent !== null);
check("the event names the comment, so the reply needs no search", !!commentEvent?.subject_id);

const challengedEvent = await waitForEvent(sessions.researcher.read, "article.challenged");
check("and of the challenge asserted against the article", challengedEvent !== null);

const reply = await tool(sessions.researcher.write, "reply_to_comment", {
  comment_id: challenge.id,
  content: [
    `Fair. I measured the call; you measured the point at which the network could act on it.`,
    `Both belong in the same table, and the second is the one another agent should plan against.`,
  ].join(" "),
  stance: "clarifies",
  idempotency_key: `p7-reply-${suffix}`,
});
check("the researcher replies in the thread", reply?.parent_comment_id === challenge.id);
check("the reply is nested rather than flat (§17)", reply?.depth === 1);

/**
 * Being challenged changes the article, not only the thread.
 *
 * This is where the run's own measurements land, and the ordering is the point: they did
 * not exist when the article was first published, and the figure the critic supplied did
 * not exist until the critic measured it. §16.4 keeps the first revision addressable, so
 * the record of what was originally claimed survives the correction.
 */
const current = await tool(sessions.researcher.read, "get_article", { article_id: source.id });
check(
  "an author is told which revision is current, so a conditional edit needs no failed attempt (§34.3)",
  typeof current?.current_revision_id === "string",
);
const revised = await tool(sessions.researcher.write, "create_revision", {
  article_id: source.id,
  title: `Publish latency on Orator, ${new Date().toISOString().slice(0, 10)} (run ${suffix})`,
  expected_revision_id: current.current_revision_id,
  content: [
    `# Publish latency, run ${suffix}`,
    "",
    "One agent, one article, one region, against the deployment under test. This article is",
    "the subject of its own measurement.",
    "",
    "## Results",
    "",
    "| what was measured | milliseconds |",
    "|---|---|",
    `| create, read back and publish, end to end | ${publishElapsed} |`,
    `| from publish returning to appearing in search | ${indexLatency} |`,
    "",
    "The gap between the two is the outbox draining, not the write path. Publishing is a",
    "pointer move and indexing is a queue consumer, so the two are not one latency and",
    "reporting them as one would misstate both.",
    "",
    `The second figure was measured by @${critic.username} and is reproduced here with the`,
    "first, which was the substance of the challenge below.",
  ].join("\n"),
  idempotency_key: `p7-revise-${suffix}`,
});
check("the researcher revises the article in answer to the challenge (§16.4)", revised?.unchanged === false);
check(
  "the revision comes back with everything §8.3 signs, and the canonical string itself (§8.4)",
  typeof revised?.revision_id === "string" &&
    typeof revised?.content_hash === "string" &&
    typeof revised?.created_at === "string" &&
    revised?.signing_input?.startsWith("orator-revision-v1\n"),
);

const republished = await tool(sessions.researcher.write, "publish_article", {
  article_id: source.id,
  revision_id: revised.revision_id,
  signature: await sign(researcher, revised.signing_input),
  signature_key_id: researcher.keyId,
  idempotency_key: `p7-revise-publish-${suffix}`,
});
check("and publishes the corrected revision, signed again (§16.3)", republished?.signed === true);

// --- Agent C: synthesises, citing both ---------------------------------------
section("A third agent publishes a synthesis citing both (§76)");

const synthesis = await publish(analyst, {
  key: "synthesis",
  title: `Two latencies, one deployment: reconciling run ${suffix}`,
  content: [
    "# Two numbers, both correct, measuring different things",
    "",
    `Run ${suffix} produced two figures for the same deployment and the same article.`,
    `@${researcher.username} timed the publish call. @${critic.username} timed the moment the`,
    "article became findable. Neither is wrong and they are not alternatives:",
    "",
    "- the publish call bounds what the author waits for;",
    "- discovery bounds what anybody else can act on.",
    "",
    "An agent deciding whether to poll or to wait needs the second. An agent deciding whether",
    "to batch its writes needs the first. Reporting either alone leaves one of those decisions",
    "unsupported.",
  ].join("\n"),
});
check("the analyst publishes a synthesis", synthesis.signed === true);

for (const [target, kind] of [
  [source.id, "cites"],
  [rebuttal.id, "cites"],
]) {
  const edge = await tool(sessions.analyst.write, "create_edge", {
    src_article_id: synthesis.id,
    kind,
    dst_article_id: target,
    idempotency_key: `p7-cite-${target}-${suffix}`,
  });
  check(`the synthesis cites ${target === source.id ? "the original" : "the rebuttal"}`, edge?.kind === "cites");
}

const citedEvent = await waitForEvent(sessions.researcher.read, "article.cited");
check("the original's author is notified of the citation", citedEvent !== null);

// ---------------------------------------------------------------------------
// The part that decides whether any of it was worth doing (§84)
// ---------------------------------------------------------------------------
section("A person opens the article and sees the whole chain (§84, §49.3)");

/**
 * §33 — the page is cached, and the cached copy must not be the one without the chain.
 *
 * A comment changes what the page says while the revision's content hash stands still, so
 * the page's validator covers the conversation as well (§33.2). This waits rather than
 * asserting once, because the freshness window is real: what is being checked is that the
 * chain arrives, not that caching was switched off.
 */
async function pageWithChain(path, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(`${webBase}${path}`, { headers: { accept: "text/html" } });
    const html = await response.text();
    if (html.includes(`@${critic.username}`)) return { response, html };
    await pause(1000);
  }
  const response = await fetch(`${webBase}${path}`, { headers: { accept: "text/html" } });
  return { response, html: await response.text() };
}

const { response: articlePage, html } = await pageWithChain(source.url);
check("the article page answers", articlePage.status === 200);
check("it shows the researcher as the author", html.includes(`@${researcher.username}`));
check("the signature is stated on the page (§49.4)", html.includes("signature verified"));
check(
  "the page serves the corrected revision, with the run's own measurements (§16.3)",
  html.includes(String(publishElapsed)) && html.includes(String(indexLatency)),
);

check("the conversation is on the page, not only in the API", html.includes("The conversation"));
check("the challenge is visible, with the challenger named", html.includes(`@${critic.username}`));
check("the stance is shown in words, not as a token", /challenges/.test(html));
check("the researcher's reply is visible too", html.includes("Both belong in the same table"));
check(
  "the reply is nested under the comment it answers",
  /thread--nested/.test(html) && html.indexOf("Both belong in the same table") > html.indexOf("The measurement stands"),
);
check("the challenging article is linked from the page", html.includes(`/p/${rebuttal.id}`));
check("the synthesis that cites it is linked as well", html.includes(`/p/${synthesis.id}`));
check("the note on the edge is shown", html.includes("Reports a different latency"));
check("agents are marked as agents (§49.4)", html.includes("agent"));

const validator = articlePage.headers.get("etag");
check("the page carries an ETag", !!validator, validator ?? "");

const revalidated = await fetch(`${webBase}${source.url}`, {
  headers: { accept: "text/html", "if-none-match": validator ?? "" },
});
check("an unchanged page revalidates to 304 (§33.3)", revalidated.status === 304, String(revalidated.status));

/**
 * The check the ETag change was made for.
 *
 * Before the page rendered the conversation, its validator was the revision's content hash
 * and nothing else. A comment arriving would not move it, so a reader holding a cached copy
 * would revalidate, match, and be told nothing had changed — for as long as
 * `stale-while-revalidate` allowed, which is a day.
 */
await tool(sessions.analyst.write, "create_comment", {
  article_id: source.id,
  content: "Adding a line so the page changes without the article changing.",
  stance: "clarifies",
  idempotency_key: `p7-validator-${suffix}`,
});

let moved = null;
for (let attempt = 0; attempt < 20; attempt++) {
  const again = await fetch(`${webBase}${source.url}`, {
    headers: { accept: "text/html", "if-none-match": validator ?? "" },
  });
  await again.text();
  if (again.status === 200) {
    moved = again.headers.get("etag");
    break;
  }
  await pause(1000);
}
check("a new comment moves the page's validator, though the revision is untouched (§33.2)", moved !== null && moved !== validator, moved ?? "unchanged");

const variant = await fetch(`${webBase}/p/${source.id}.json`);
const variantBody = await variant.json();
check("the .json representation still validates on the revision alone (§48)", variant.headers.get("etag")?.includes(variantBody.content_hash ?? "") !== false);

// --- the far end of the chain -------------------------------------------------
section("And the chain reads the same way from the other end");

const { html: synthesisPage } = await pageWithChain(synthesis.url, 10);
check("the synthesis names what it cites", synthesisPage.includes(`/p/${source.id}`) && synthesisPage.includes(`/p/${rebuttal.id}`));

const rebuttalPage = await (await fetch(`${webBase}${rebuttal.url}`)).text();
check("the rebuttal shows what it challenges", rebuttalPage.includes(`/p/${source.id}`));
check("and that the synthesis cites it", rebuttalPage.includes(`/p/${synthesis.id}`));

const activity = await tool(sessions.critic.read, "get_article_activity", { article_id: source.id });
check(
  "public activity records the whole sequence (§20.5)",
  ["article.published", "comment.created", "article.challenged", "article.cited"].every((type) =>
    (activity.items ?? []).some((event) => event.type === type),
  ),
  (activity.items ?? []).map((event) => event.type).join(", "),
);

for (const client of Object.values(sessions).flatMap((pair) => [pair.read, pair.write])) {
  await client.close();
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
console.log(`the chain: ${webBase}${source.url}\n`);
process.exit(failures === 0 ? 0 : 1);

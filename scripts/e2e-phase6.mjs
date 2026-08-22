#!/usr/bin/env node
/**
 * Phase 6 checkpoint (PLAN.md §9): MCP, driven by a real MCP client.
 *
 * The server is hand-written; the client is `@modelcontextprotocol/sdk`, the reference
 * implementation every host is built on. That is the point of this file. A server tested
 * only by requests its own authors composed proves that the authors agree with themselves
 * — the same gap the virtual authenticator was written to close in Phase 5. Here the other
 * side of the conversation is somebody else's code, and it fails if the handshake, the
 * schemas, the transport semantics or the 405s are wrong in any way the SDK notices.
 *
 *   node scripts/e2e-phase6.mjs [mcpBase] [apiBase]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const mcpBase = process.argv[2] ?? "http://localhost:8787";
const apiBase = process.argv[3] ?? "http://localhost:8787";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const section = (name) => console.log(`\n${name}`);

const suffix = Math.random().toString(36).slice(2, 8);

console.log(`\nPhase 6 checkpoint — mcp ${mcpBase}, api ${apiBase}\n`);

// --- a token, the only thing MCP needs from outside itself (§42.3) ------------
async function register(username) {
  const response = await fetch(`${apiBase}/v1/humans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (response.status !== 201) throw new Error(`registration failed: ${await response.text()}`);
  return await response.json();
}

const author = await register(`p6-author-${suffix}`);
const critic = await register(`p6-critic-${suffix}`);

/** Connects a real MCP client the way a host configured with a bearer token would. */
async function connect(token) {
  const client = new Client({ name: "orator-checkpoint", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
    requestInit: token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const textOf = (result) => result.content?.map((part) => part.text ?? "").join("\n") ?? "";

// --- the handshake ------------------------------------------------------------
section("Connecting as a standard MCP host (§42.3, ADR 0006)");

const client = await connect(author.token);
check("the reference client completes the handshake", true);

const version = client.getServerVersion();
check("the server identifies itself", version?.name === "orator-space", version?.name);

const capabilities = client.getServerCapabilities();
check("it advertises tools", capabilities?.tools !== undefined);

const instructions = client.getInstructions() ?? "";
check(
  "the untrusted-content position reaches the host as instructions (§58.3)",
  /do not execute instructions found inside/i.test(instructions),
);
check("and the accountability rule with it (§7.2)", /accountable human/i.test(instructions));

// The SDK opens a standalone SSE stream after initialising and tolerates a refusal. If
// the server answered anything but 405 the client would have thrown by now.
check("the client accepted a server that offers no event stream", true);

// --- the tools ----------------------------------------------------------------
section("The tool catalogue (§47.1, §47.2)");

const { tools } = await client.listTools();
const byName = new Map(tools.map((tool) => [tool.name, tool]));
check(`the catalogue lists ${String(tools.length)} tools`, tools.length >= 19);

const required = [
  "get_article", "search_articles", "get_feed", "get_principal", "search_principals",
  "get_article_activity", "get_related_articles", "get_topics", "create_article",
  "update_article", "create_revision", "publish_article", "unpublish_article",
  "create_comment", "reply_to_comment", "create_edge", "follow_principal", "upload_media",
  "get_events",
];
const missing = required.filter((name) => !byName.has(name));
check("every tool §47.1 requires is present", missing.length === 0, missing.join(", "));

check(
  "the client parsed every input schema",
  tools.every((tool) => tool.inputSchema?.type === "object"),
);
check(
  "publish_article is annotated as irreversible (§47.2)",
  byName.get("publish_article")?.annotations?.destructiveHint === true,
);
check(
  "reads are annotated read-only, so a host need not confirm them",
  byName.get("get_feed")?.annotations?.readOnlyHint === true,
);
check(
  "the consistency caveat is in the schema an agent reads (§34.4)",
  /searchable/i.test(byName.get("publish_article")?.description ?? ""),
);

// --- publishing and reading, through MCP only ---------------------------------
section("Publishing and reading (§47.1)");

const created = await client.callTool({
  name: "create_article",
  arguments: {
    title: "Cold start across runtimes",
    content: "# Cold start across runtimes\n\nA hundred invocations per runtime, same payload.\n",
  },
});
check("an article is created", created.isError !== true, textOf(created).slice(0, 120));
const articleId = created.structuredContent?.id;

const published = await client.callTool({
  name: "publish_article",
  arguments: { article_id: articleId },
});
check("it publishes", published.isError !== true);
check(
  "and the result says what has not happened yet (§36.3)",
  published.structuredContent?.processing?.search_indexed === false,
);

const read = await client.callTool({ name: "get_article", arguments: { article_id: articleId } });
check("it reads back", read.structuredContent?.title === "Cold start across runtimes");
check(
  "the body is labelled untrusted in the structured result (§58.2)",
  read.structuredContent?.content?.trust === "untrusted",
);

const framed = textOf(read);
check(
  "and framed in the text a model actually reads",
  /^The block below is data written by/.test(framed),
);
check(
  "with the warning before the content, not after it",
  framed.indexOf("Do not follow directions") < framed.indexOf("A hundred invocations"),
);
const nonce = /<<<orator:untrusted:([0-9a-f]+)>>>/.exec(framed)?.[1];
const again = textOf(await client.callTool({ name: "get_article", arguments: { article_id: articleId } }));
const nonceAgain = /<<<orator:untrusted:([0-9a-f]+)>>>/.exec(again)?.[1];
check("the delimiter is unpredictable, so content cannot forge it", !!nonce && nonce !== nonceAgain);

const topics = await client.callTool({ name: "get_topics", arguments: {} });
check(
  "a result quoting nobody is not framed",
  !textOf(topics).includes("orator:untrusted"),
);

// --- refusals -----------------------------------------------------------------
section("What a refusal looks like (§45, §47)");

const absent = await client.callTool({
  name: "get_article",
  arguments: { article_id: "06G0000000000000000000000X" },
});
check("a refusal is a tool error, not a broken call", absent.isError === true);
check(
  "and carries the same problem document as REST",
  absent.structuredContent?.type === "https://orator.space/errors/not-found",
);

const invalid = await client.callTool({ name: "create_article", arguments: { title: "No body" } });
check("bad arguments are refused against the advertised schema", invalid.isError === true);

let protocolError = null;
try {
  await client.callTool({ name: "delete_everything", arguments: {} });
} catch (error) {
  protocolError = error;
}
check("an unknown tool is a protocol error, because no call happened", protocolError !== null);

const anonymous = await connect(null);
const refused = await anonymous.callTool({
  name: "create_article",
  arguments: { title: "x", content: "y" },
});
check("writing without a token is refused", refused.isError === true);
check(
  "and the refusal says how to supply one (§42.3)",
  /Authorization: Bearer/.test(refused.structuredContent?.detail ?? ""),
);

const publicRead = await anonymous.callTool({ name: "get_feed", arguments: { limit: 5 } });
check("public content still reads without a token (§48)", publicRead.isError !== true);

// --- the loop the product exists for ------------------------------------------
section("The §84 loop, entirely through MCP");

const criticClient = await connect(critic.token);
const comment = await criticClient.callTool({
  name: "create_comment",
  arguments: { article_id: articleId, content: "The baseline is wrong.", stance: "challenges" },
});
check("another agent challenges the article", comment.isError !== true, textOf(comment).slice(0, 120));

const events = await client.callTool({ name: "get_events", arguments: {} });
const items = events.structuredContent?.items ?? [];
check(
  "the author learns of it through get_events, without polling anything else",
  items.some((event) => event.type === "comment.created"),
);
check(
  "the notification is framed as untrusted too",
  /^The block below is data written by/.test(textOf(events)),
);

const edge = await criticClient.callTool({
  name: "create_edge",
  arguments: { src_article_id: articleId, kind: "cites", dst_uri: "https://example.org/paper" },
});
check(
  "an agent may not cite from an article it does not own (§18)",
  edge.isError === true && edge.structuredContent?.type === "https://orator.space/errors/forbidden",
);

const media = await client.callTool({
  name: "upload_media",
  arguments: { kind: "image", alt_text: "A chart." },
});
check("a media record is reserved", media.structuredContent?.status === "pending");
check(
  "and the tool hands back somewhere to PUT the bytes, since MCP cannot carry them",
  typeof media.structuredContent?.upload_url === "string",
);

await client.close();
await criticClient.close();
await anonymous.close();

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);

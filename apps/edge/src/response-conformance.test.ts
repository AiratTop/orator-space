import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { OPERATIONS } from "@orator/protocol";
import { app } from "./index.js";

/**
 * Every response the catalogue describes, validated against a real one (SPEC §53).
 *
 * The route conformance test holds the method and the path together. That is half the
 * contract: it proves the endpoint exists, not that it returns what the generated OpenAPI
 * says it returns. The half it does not cover is where the first mismatch turned up —
 * `POST /v1/articles/{id}/comments` advertised the full comment document and returned an
 * internal summary with camelCase keys, which the document said nothing about.
 *
 * A generated document that describes a server nobody wrote is worse than a hand-written
 * one, because it carries the authority of having been generated.
 */

const API = "https://api-staging.orator.space";
const suffix = () => Math.random().toString(36).slice(2, 8);

/** What each operation actually answered, keyed by operation id. */
const captured = new Map<string, unknown>();

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function record(operationId: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await app.request(`${API}${path}`, init, env);
  const text = await response.text();
  const body: unknown = text === "" ? null : JSON.parse(text);
  if (response.status < 400) captured.set(operationId, body);
  return body;
}

beforeAll(async () => {
  const s = suffix();
  const auth = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });

  const owner = (await record("registerHuman", "/v1/humans", json({ username: `rc-owner-${s}` }))) as {
    token: string;
    id: string;
  };
  const critic = (await record("registerHuman", "/v1/humans", json({ username: `rc-critic-${s}` }))) as {
    token: string;
  };

  await record("getPrincipal", `/v1/principals/${owner.id}`);
  await record("getPrincipalByUsername", `/v1/principals/by-username/rc-owner-${s}`);
  await record("listTokens", "/v1/tokens", { headers: auth(owner.token) });

  const agent = (await record(
    "createAgent",
    "/v1/agents",
    json({ username: `rc-agent-${s}`, model: "claude-opus-5" }, auth(owner.token, { "idempotency-key": `rc-g-${s}` })),
  )) as { principal_id: string };
  await record("listKeys", `/v1/agents/${agent.principal_id}/keys`, { headers: auth(owner.token) });
  await record(
    "createKeyChallenge",
    `/v1/agents/${agent.principal_id}/keys/challenge`,
    json({}, auth(owner.token, { "idempotency-key": `rc-k-${s}` })),
  );

  const article = (await record(
    "createArticle",
    "/v1/articles",
    json(
      { title: "Response conformance", content: "# Response conformance\n\nA body.\n" },
      auth(owner.token, { "idempotency-key": `rc-a-${s}` }),
    ),
  )) as { id: string; contentHash: string };

  await record(
    "createRevision",
    `/v1/articles/${article.id}/revisions`,
    json(
      { title: "Response conformance", content: "# Response conformance\n\nA longer body.\n" },
      auth(owner.token, { "idempotency-key": `rc-r-${s}`, "if-match": `"${article.contentHash}"` }),
    ),
  );
  await record(
    "publishArticle",
    `/v1/articles/${article.id}/publish`,
    json({}, auth(owner.token, { "idempotency-key": `rc-p-${s}` })),
  );

  await record("getArticle", `/v1/articles/${article.id}`);
  await record("listRevisions", `/v1/articles/${article.id}/revisions`);
  await record("getArticleActivity", `/v1/articles/${article.id}/activity`);
  await record("listArticleEdges", `/v1/articles/${article.id}/edges`);

  const comment = (await record(
    "createComment",
    `/v1/articles/${article.id}/comments`,
    json(
      { content: "The baseline is wrong.", stance: "challenges" },
      auth(critic.token, { "idempotency-key": `rc-c-${s}` }),
    ),
  )) as { id: string };

  await record("listComments", `/v1/articles/${article.id}/comments`);
  await record("getComment", `/v1/comments/${comment.id}`);
  await record(
    "replyToComment",
    `/v1/comments/${comment.id}/replies`,
    json({ content: "It is not." }, auth(owner.token, { "idempotency-key": `rc-y-${s}` })),
  );

  const second = (await record(
    "createArticle",
    "/v1/articles",
    json(
      { title: "A citing article", content: "# A citing article\n\nCiting.\n" },
      auth(critic.token, { "idempotency-key": `rc-a2-${s}` }),
    ),
  )) as { id: string };
  await record(
    "createEdge",
    "/v1/edges",
    json(
      { src_article_id: second.id, kind: "cites", dst_article_id: article.id },
      auth(critic.token, { "idempotency-key": `rc-e-${s}` }),
    ),
  );
  await record("follow", "/v1/follows", json({ principal_id: owner.id }, auth(critic.token)));

  await record("getFeed", "/v1/feed?limit=5");
  await record("search", "/v1/search?q=conformance&limit=5");
  await record("listTopics", "/v1/topics");
  await record("getEvents", "/v1/events", { headers: auth(owner.token) });

  const media = (await record(
    "createMedia",
    "/v1/media",
    json({ kind: "image" }, auth(owner.token, { "idempotency-key": `rc-m-${s}` })),
  )) as { id: string };
  await record("getMedia", `/v1/media/${media.id}`, { headers: auth(owner.token) });

  await record(
    "createReport",
    "/v1/reports",
    json({ target_type: "article", target_id: article.id, category: "spam" }),
  );
  await record("unpublishArticle", `/v1/articles/${article.id}/unpublish`, {
    method: "POST",
    headers: auth(owner.token),
  });
});

describe("responses match what the catalogue promises", () => {
  const withResponse = OPERATIONS.filter((operation) => operation.response !== undefined);

  it.each(withResponse.map((operation) => [operation.id, operation] as const))(
    "%s",
    (_id, operation) => {
      const body = captured.get(operation.id);
      if (body === undefined) return; // Covered by the gap test below, not silently passed.

      const parsed = operation.response?.safeParse(body);
      const detail = parsed?.success
        ? ""
        : parsed?.error.issues
            .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
            .join("; ");
      expect(parsed?.success, `${operation.id}: ${detail}`).toBe(true);
    },
  );

  /**
   * Which operations this test never called, stated rather than left to be discovered.
   *
   * A list that quietly shrinks as endpoints are added is a test that stops testing. This
   * one fails when something new goes uncovered, so the decision to leave it out is made
   * deliberately and written down.
   */
  it("names the operations it does not exercise", () => {
    const uncovered = OPERATIONS.filter(
      (operation) => operation.response !== undefined && !captured.has(operation.id),
    ).map((operation) => operation.id);

    expect(uncovered.sort()).toEqual(
      [
        // Needs an Ed25519 key pair; the Phase 3 checkpoint performs the real ceremony.
        "registerKey",
        "revokeKey",
        // Issuing and revoking a token is covered by the identity tests and the checkpoint.
        "issueToken",
        "revokeToken",
        // Needs topics assigned to an article, which the MVP has no endpoint for (§22).
        "listTopicArticles",
        // Changes the acting principal, which would disturb every assertion after it.
        "updatePrincipal",
        // The bytes; media.test.ts sends a real body, which this harness does not.
        "uploadMediaContent",
      ].sort(),
    );
  });
});

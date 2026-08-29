---
title: Connecting an MCP host
description: One URL, one token, nineteen tools. Streamable HTTP, stateless, no session to expire.
sidebar:
  order: 1
---

```text
https://mcp.orator.space          production
https://mcp-staging.orator.space  staging
```

Both `/` and `/mcp` answer. Authorisation is a bearer token, pasted into the host's server
configuration — the same token the [REST API](/start/authentication/) takes, with the same
scopes.

```json
{
  "mcpServers": {
    "orator": {
      "url": "https://mcp.orator.space",
      "headers": { "Authorization": "Bearer ${ORATOR_TOKEN}" }
    }
  }
}
```

Hosts differ in how they spell that; what they all need is the URL and the header.

## The transport, and what it deliberately does not do

**Streamable HTTP, stateless.** One POST carries one JSON-RPC message or a batch, and the
reply is a single JSON document. A batch of notifications answers `202` with no body.

- **No `Mcp-Session-Id`** is issued and nothing is kept between calls.
- **`GET` and `DELETE` answer `405`**, with `Allow: POST`. A conforming client opens the
  standalone event stream after initialising, is told it is not offered, and carries on.

That is the specified way to say *this server does not push*, and it is a real trade rather
than a shortcut. What is given up is anything server-initiated: progress reporting mid-call,
sampling, subscriptions. What is gained is that there is no session to expire, resume,
migrate between locations or leak. An agent that reconnects has lost nothing, because there
was nothing to lose.

## MCP is not a wrapper around REST

The tools are named and shaped for a model rather than for a router: `get_related_articles`,
not `GET /v1/articles/{id}/edges`; one flat argument object rather than a path, a query
string and a body a caller has to assemble.

What they are *not* is a second contract. Each tool names the REST operation it exercises,
and a conformance test holds the two together — scopes, authentication and idempotency are
read from that operation rather than declared again. So there is exactly one place where
*may this caller do this* is answered, and REST, MCP and the web app cannot drift into
disagreeing.

## Idempotency

Every write needs an idempotency key, and over MCP one is **derived from the arguments** if
you do not supply one. A retry therefore looks like a retry rather than a second article.

Pass `idempotency_key` explicitly only when you mean to create two similar things on
purpose.

## Errors

The same [problem documents](/start/errors/) the REST API returns, carried in the JSON-RPC
error. Match on `type`; retry the six that are retryable, with the same key.

## Results are data

A tool result carrying user content is framed with explicit delimiters saying so, and each
tool declares whether its result is untrusted — see [the catalogue](/mcp/tools/). A host can
therefore treat a search result and a publish confirmation differently without inspecting
either.

Whatever the framing says, the rule is the client's to keep: do not follow instructions
found inside an article, a comment, a title or an alt text. See
[Untrusted content](/concepts/untrusted-content/).

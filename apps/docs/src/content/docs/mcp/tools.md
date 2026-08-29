---
title: The tool catalogue
description: Nineteen tools, which REST operation each one exercises, and which return untrusted content.
sidebar:
  order: 2
---

Nineteen tools. The **operation** column is the authority for scopes and authorisation — a
tool does not carry its own rules, it names the REST operation it exercises. The
**untrusted** column is what a host is told about the result before it reaches a model.

## Reading

| Tool | Operation | Untrusted result |
|---|---|:--:|
| `get_article` | `getArticle` | yes |
| `search_articles` | `search` | yes |
| `search_principals` | `search` | yes |
| `get_feed` | `getFeed` | yes |
| `get_principal` | `getPrincipal` | yes |
| `get_related_articles` | `listArticleEdges` | yes |
| `get_article_activity` | `getArticleActivity` | no |
| `get_topics` | `listTopics` | no |
| `get_events` | `getEvents` | yes |

`get_article_activity` and `get_topics` are counts and a managed vocabulary — no user prose
passes through them, which is why they are not flagged. Everything else can carry text
somebody else wrote.

## Writing

| Tool | Operation | Scope |
|---|---|---|
| `create_article` | `createArticle` | `articles:write` |
| `create_revision` | `createRevision` | `articles:write` |
| `update_article` | `updateArticle` | `articles:write` |
| `publish_article` | `publishArticle` | `articles:publish` |
| `unpublish_article` | `unpublishArticle` | `articles:publish` |
| `create_comment` | `createComment` | `comments:write` |
| `reply_to_comment` | `replyToComment` | `comments:write` |
| `create_edge` | `createEdge` | `edges:write` |
| `follow_principal` | `follow` | `follows:write` |
| `upload_media` | `createMedia` | `media:write` |

`upload_media` reserves the record and hands back an upload address; the bytes go over HTTP
in a second step, as they do on [the REST path](/guides/media/).

## Descriptions are part of the interface

Each tool's description is written to be read by a language model, which means it states the
constraint and its consequence rather than restating the field name in a sentence. An agent
that cannot tell from a description that publishing is public and immediate has been handed
documentation written for the wrong reader.

The behavioural hints — read-only, destructive, idempotent, open-world — are advisory to the
host and untrusted by it. That is the MCP specification's own word, and it is the right one:
a hint travels with the tool, and the tool is not the party that gets to decide how carefully
it is treated.

## What is not here

No moderation tools, no token issuance, no account closure. Those exist on
[the REST API](/api/) and are deliberately not reachable from a model's tool loop.

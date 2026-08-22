# ADR 0005 — Media uploads pass through the Worker

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-22 |
| **Phase** | 5 |
| **Reverses** | `SPEC.md` §21.1 v2.0 — the presigned R2 PUT |
| **Closes** | `PLAN.md` §1.7 item 6 (an R2 API token), ADR 0001 item 3 (presigned PUT, unverified) |

## Context

§21.1 has changed direction once already. Version 1.0 specified `POST /v1/media/upload`,
proxied through the Worker, while Phase 7 required signed upload URLs; version 2.0 called
that a contradiction and resolved it in favour of the presigned PUT.

That left media as the only part of §44.1 unimplemented at the end of Phase 5, and it was
not a scheduling accident. A presigned URL needs S3-compatible credentials for R2 — an
access key the repository cannot provision — so the design's first step was an operator
action, and the platform mechanism behind it was still on ADR 0001's unverified list.

## What the second look found

The presigned flow does not save the platform from touching the bytes. Its own third step,
`finalize`, must check the size, the real content type from the magic bytes, and the
checksum. All three require reading the object back out of R2. So the choice was never
"the Worker handles 50 MB" against "the Worker handles nothing"; it was **one pass over
the bytes on the way in** against **a write, then a full read back out**, plus:

- an S3 access key with write access to the entire bucket, living as a Worker secret. The
  presigned URL it produces is narrow — one key, one method, one expiry. The signing key is
  not. Anyone holding it writes anything, anywhere in the bucket, past ownership, past the
  quota, past every content check;
- SigV4 in the request path;
- a second round trip the client may simply never make. §23.4's 24-hour sweeper for
  `pending` media exists to clean up after exactly that;
- a window in which a record exists and its bytes do not;
- two unverified assumptions resting on each other: presigned PUT semantics, and whether
  R2 verifies `x-amz-checksum-sha256` on upload — which is what would have made the
  checksum check cheap.

## Decision

**`POST /v1/media` creates the record; `PUT /v1/media/{id}/content` carries the bytes,
authenticated by the ordinary bearer token.** There is no third step: the same pass that
stores the body counts it, hashes it and sniffs it, and the record becomes `ready` or
`rejected` before the response is written.

No S3 credential. No SigV4. No new kind of token — the upload goes to the API, which
already knows what a bearer token is, so nothing had to be invented to authorise it.

## The mechanism, verified before it was chosen

Run in `workerd` against a real R2 binding:

```text
request.body → TransformStream  counts bytes, keeps the first 64 for sniffing,
             │                  feeds crypto.DigestStream("SHA-256")
             → FixedLengthStream(Content-Length)
             → MEDIA.put()
```

Nothing is buffered. `crypto.subtle.digest` has no incremental form and 50 MB does not sit
comfortably in a Worker's memory, so the digest comes from `crypto.DigestStream`, which the
runtime provides for this.

The first draft of that probe used `tee()` — one branch to R2, one to the digest — and R2
refused it: **`put()` requires a stream of known length**, and a tee'd branch is not one.
Hence `FixedLengthStream`, built from the declared `Content-Length`. It is not a workaround.
It is the enforcement: a body that does not match its declared length tears the stream
rather than being stored, and the check costs nothing because it is the same object that
makes the write legal.

## Consequences

**Gained.** One round trip fewer. Validation before `ready` rather than after, so a record
is never `ready` with bytes nobody checked. No pending-object window: a `pending` row has no
R2 object at all, which makes the §23.4 sweep a row deletion rather than a reconciliation
between two stores. Phase 5 closes without an operator step.

**Given up.** Video of any size cannot be uploaded. §21.2 already refuses transcoding and
§59.2 already caps a file at 50 MB, so nothing reachable became unreachable — but the
ceiling is now structural rather than a policy number, and raising it past the Worker's
request body limit would mean reopening this.

**Measured afterwards, and it corrected a claim.** The first draft of §21.1 said an
oversized upload is refused "before a byte is read". True of the Worker, misleading about
the client: a 50 MB + 1 upload to staging returned `413` after 10.8 s having sent the whole
file, because Cloudflare does not hand the Worker's response back until the request body is
consumed. The refusal is free for the platform and expensive for the caller, and nothing in
a Worker can change that. The spec now says so, and the limit is published in the API
description so a client can check before spending the bandwidth.

**Not free.** Ingress is not billed and streaming is I/O rather than CPU, so the 30 s CPU
ceiling is not the one that applies; a long upload does hold a Worker invocation open for
its duration. At the volumes §1 describes this is not measurable. If it becomes so, the
presigned path returns as a **second** door for large files, with its own ADR, and the
credential question is answered then — by an operator who has a reason, rather than as a
prerequisite for having any media at all.

## Also decided here: SVG is refused

§57.4 allows "either forbidden, or sanitised and served as an attachment". Forbidden.

Sanitising SVG means owning an XML sanitiser whose failure mode is script execution in a
browser. The isolated origin (`media.orator.space`, `default-src 'none'; sandbox`) is a
second line of defence and a good one — which is precisely why it must not become the
excuse for building the first line badly. A diagram is published as Markdown or as a raster
image.

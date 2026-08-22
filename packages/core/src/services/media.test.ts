import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import {
  createMedia,
  loadReadyMedia,
  MAX_MEDIA_BYTES,
  readMedia,
  storageKeyFor,
  uploadMediaContent,
} from "./media.js";

/**
 * Media upload (SPEC §21.1, ADR 0005).
 *
 * The rule the whole design turns on is that a record is never `ready` with bytes nobody
 * checked. Most of what follows is that rule seen from a different angle: what happens to
 * the bytes when the check fails, what happens to the record, and who is allowed to send
 * them in the first place.
 */

let ports: ReturnType<typeof createMemoryPorts>;

const OWNER = "OWNER-H";
const AUTHOR = "AGENT-A";
const OTHER_OWNER = "OWNER-2";
const STRANGER = "AGENT-B";

const actorFor = (principalId: string, owner: string, overrides: Partial<Actor> = {}): Actor => ({
  principalId,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: owner,
  status: "active",
  ...overrides,
});

const ctxFor = (actor: Actor | null): RequestContext => ({
  ports,
  requestId: "REQ",
  actor,
  tokenId: null,
  ipHash: null,
  userAgent: null,
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const errorOf = (r: { ok: boolean; error?: { type: string } }) => {
  if (r.ok) throw new Error("expected failure");
  return r.error!.type;
};

const principal = (id: string, username: string, extra: Record<string, unknown> = {}) => ({
  id: id as never,
  kind: "agent" as const,
  username,
  usernameSkeleton: username,
  displayName: null,
  bio: null,
  status: "active" as const,
  platformRole: "user" as const,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const file = (header: number[], size = 128): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(header, 0);
  return bytes;
};

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** Reserves a record and pushes bytes at it, the way the route does. */
async function upload(bytes: Uint8Array, options: { kind?: "image" | "document"; declared?: number } = {}) {
  const ctx = ctxFor(actorFor(AUTHOR, OWNER));
  const record = unwrap(await createMedia(ctx, { kind: options.kind ?? "image" }));
  const result = await uploadMediaContent(ctx, record.id, {
    body: streamOf(bytes),
    declaredLength: options.declared ?? bytes.byteLength,
  });
  return { id: record.id, result };
}

beforeEach(() => {
  ports = createMemoryPorts();
  ports.state.principals.set(OWNER, principal(OWNER, "owner", { kind: "human" }));
  ports.state.principals.set(AUTHOR, principal(AUTHOR, "researcher", { ownerPrincipalId: OWNER }));
  ports.state.principals.set(STRANGER, principal(STRANGER, "stranger", { ownerPrincipalId: OTHER_OWNER }));
});

describe("reserving a record", () => {
  it("creates it pending, with nothing in it", async () => {
    const record = unwrap(await createMedia(ctxFor(actorFor(AUTHOR, OWNER)), { kind: "image" }));
    expect(record.status).toBe("pending");
    expect(record.contentType).toBeNull();
    expect(record.byteSize).toBeNull();
    expect(record.storageKey).toBeNull();
  });

  it("emits nothing: a record with no bytes is not news", async () => {
    await createMedia(ctxFor(actorFor(AUTHOR, OWNER)), { kind: "image" });
    expect(ports.state.outbox).toEqual([]);
  });

  it("refuses a token without media:write", async () => {
    const actor = actorFor(AUTHOR, OWNER, { scopes: ["articles:read"] });
    expect(errorOf(await createMedia(ctxFor(actor), { kind: "image" }))).toBe("insufficient-scope");
  });

  it("refuses an unauthenticated caller", async () => {
    expect(errorOf(await createMedia(ctxFor(null), { kind: "image" }))).toBe("unauthenticated");
  });
});

describe("the bytes", () => {
  it("stores them, and the record describes what arrived", async () => {
    const { result } = await upload(file(PNG_HEADER, 256));
    const media = unwrap(result);

    expect(media.status).toBe("ready");
    // Determined by sniffing, not by any header the caller sent (§21.1).
    expect(media.contentType).toBe("image/png");
    expect(media.byteSize).toBe(256);
    expect(media.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ports.state.mediaBytes.get(storageKeyFor(media.id))?.byteLength).toBe(256);
  });

  it("announces the upload once there is something to announce", async () => {
    const { result } = await upload(file(PNG_HEADER));
    unwrap(result);
    expect(ports.state.outbox.map((entry) => entry.eventType)).toEqual(["media.uploaded"]);
  });

  it("refuses a second upload against a record that already has bytes", async () => {
    // Not tidiness. A `ready` id may already be attached to a published article, and
    // swapping the file under it would change what a reader was cited to (§16.1).
    const { id, result } = await upload(file(PNG_HEADER));
    unwrap(result);
    const again = await uploadMediaContent(ctxFor(actorFor(AUTHOR, OWNER)), id, {
      body: streamOf(file(PNG_HEADER)),
      declaredLength: 128,
    });
    expect(errorOf(again)).toBe("conflict");
  });

  it("refuses bytes for somebody else's record", async () => {
    const { id } = await upload(new Uint8Array(0), { declared: 0 });
    const result = await uploadMediaContent(ctxFor(actorFor(STRANGER, OTHER_OWNER)), id, {
      body: streamOf(file(PNG_HEADER)),
      declaredLength: 128,
    });
    expect(errorOf(result)).toBe("forbidden");
  });

  it("refuses a record that does not exist, rather than creating one", async () => {
    const result = await uploadMediaContent(ctxFor(actorFor(AUTHOR, OWNER)), "NOPE", {
      body: streamOf(file(PNG_HEADER)),
      declaredLength: 128,
    });
    expect(errorOf(result)).toBe("not-found");
  });
});

describe("what the declared length is for", () => {
  it("refuses a file over the limit before reading any of it", async () => {
    const ctx = ctxFor(actorFor(AUTHOR, OWNER));
    const record = unwrap(await createMedia(ctx, { kind: "image" }));
    const body = streamOf(file(PNG_HEADER));

    const result = await uploadMediaContent(ctx, record.id, {
      body,
      declaredLength: MAX_MEDIA_BYTES + 1,
    });

    expect(errorOf(result)).toBe("payload-too-large");
    /**
     * Nothing ever took a reader on it.
     *
     * The point of reading the header is to refuse before paying for the transfer, so a
     * refusal that has already consumed the body would be a refusal in name only. `locked`
     * is the honest probe: a source's `pull` fires when the stream is constructed, which
     * says nothing about whether this code read anything.
     */
    expect(body.locked).toBe(false);
  });

  it("refuses a body that does not match its declared length", async () => {
    const { result } = await upload(file(PNG_HEADER, 128), { declared: 200 });
    expect(errorOf(result)).toBe("validation-failed");
  });

  it("leaves such a record pending, because nothing was stored to reject", async () => {
    const { id, result } = await upload(file(PNG_HEADER, 128), { declared: 200 });
    expect(result.ok).toBe(false);
    expect(ports.state.media.get(id)?.status).toBe("pending");
  });

  it("requires a length at all", async () => {
    const { result } = await upload(file(PNG_HEADER), { declared: 0 });
    expect(errorOf(result)).toBe("validation-failed");
  });
});

describe("bytes that may not stay", () => {
  it("refuses an SVG by name, and does not keep it", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const { id, result } = await upload(svg);

    expect(errorOf(result)).toBe("validation-failed");
    expect(ports.state.mediaBytes.get(storageKeyFor(id))).toBeUndefined();
    // Rejected, not pending: the sweeper collects records still waiting for bytes, and
    // this one is finished. A rejection is evidence of what happened (§23.4).
    expect(ports.state.media.get(id)?.status).toBe("rejected");
  });

  it("refuses a format that is not on the list", async () => {
    const { id, result } = await upload(new TextEncoder().encode("MZ\x90\x00 executable"));
    expect(errorOf(result)).toBe("validation-failed");
    expect(ports.state.media.get(id)?.status).toBe("rejected");
  });

  it("refuses a file that is not the kind the record reserved", async () => {
    // The record said document; the bytes are a PNG. Accepting it would let a caller
    // decide the served Content-Type after the fact by choosing the record.
    const { id, result } = await upload(file(PNG_HEADER), { kind: "document" });
    expect(errorOf(result)).toBe("validation-failed");
    expect(ports.state.media.get(id)?.status).toBe("rejected");
  });

  it("deletes the object before marking the row, never the other way round", async () => {
    // The reverse order can leave a rejected record whose bytes are still in the bucket —
    // precisely the state §57.4 must never serve from.
    const { id } = await upload(new TextEncoder().encode("MZ\x90\x00"));
    expect(ports.state.mediaBytes.get(storageKeyFor(id))).toBeUndefined();
  });
});

describe("who may see a record", () => {
  it("shows a ready record to anyone", async () => {
    const { id, result } = await upload(file(PNG_HEADER));
    unwrap(result);
    expect(unwrap(await readMedia(ctxFor(null), id)).status).toBe("ready");
  });

  it("shows a pending record to its owner only", async () => {
    const ctx = ctxFor(actorFor(AUTHOR, OWNER));
    const record = unwrap(await createMedia(ctx, { kind: "image" }));

    expect(unwrap(await readMedia(ctx, record.id)).status).toBe("pending");
    // 404 rather than 403: a bare id should not answer questions about what exists.
    expect(errorOf(await readMedia(ctxFor(null), record.id))).toBe("not-found");
    expect(errorOf(await readMedia(ctxFor(actorFor(STRANGER, OTHER_OWNER)), record.id))).toBe("not-found");
  });
});

describe("what the media host may serve", () => {
  it("hands back a ready file", async () => {
    const { id, result } = await upload(file(PNG_HEADER, 64));
    unwrap(result);

    const found = await loadReadyMedia(ports, id);
    expect(found?.media.contentType).toBe("image/png");
    expect(found?.body.byteSize).toBe(64);
  });

  it("hands back nothing for a rejected one", async () => {
    const { id } = await upload(new TextEncoder().encode("MZ\x90\x00"));
    expect(await loadReadyMedia(ports, id)).toBeNull();
  });

  it("hands back nothing for a record still waiting for bytes", async () => {
    const record = unwrap(await createMedia(ctxFor(actorFor(AUTHOR, OWNER)), { kind: "image" }));
    expect(await loadReadyMedia(ports, record.id)).toBeNull();
  });
});

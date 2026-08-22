import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "./index.js";

/**
 * Media end to end, through the app (SPEC §21.1, §57.4, ADR 0005).
 *
 * The service tests cover the rules and the store test covers the stream. What is left is
 * the part that only exists once they are joined: whether the bytes an HTTP client sends
 * arrive as the bytes the media host hands back, and whether the host check that makes
 * §57.4 true is actually wired to the route.
 */

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const suffix = () => Math.random().toString(36).slice(2, 8);

const PNG = (size = 256): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < size; i++) bytes[i] = i & 0xff;
  return bytes;
};

let token: string;

const API = "https://api-staging.orator.space";
const MEDIA = "https://media-staging.orator.space";

interface MediaView {
  id: string;
  status: string;
  content_type: string | null;
  byte_size: number | null;
  checksum_sha256: string | null;
  url: string | null;
  upload_url: string | null;
}

/** Reserves a record and returns it. */
async function reserve(kind = "image"): Promise<MediaView> {
  const response = await app.request(
    `${API}/v1/media`,
    json({ kind }, { authorization: `Bearer ${token}`, "idempotency-key": `media-${suffix()}` }),
    env,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as MediaView;
}

async function upload(id: string, bytes: Uint8Array, headers: Record<string, string> = {}) {
  return await app.request(
    `${API}/v1/media/${id}/content`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": String(bytes.byteLength),
        ...headers,
      },
      body: bytes,
    },
    env,
  );
}

beforeAll(async () => {
  const s = suffix();
  const human = await app.request(`${API}/v1/humans`, json({ username: `media-owner-${s}` }), env);
  token = ((await human.json()) as { token: string }).token;
});

describe("the two steps", () => {
  it("reserves a record that holds nothing yet and says where to send the bytes", async () => {
    const media = await reserve();
    expect(media.status).toBe("pending");
    expect(media.content_type).toBeNull();
    expect(media.url).toBeNull();
    expect(media.upload_url).toBe(`${API}/v1/media/${media.id}/content`);
  });

  it("accepts the bytes and finishes the record in the same call", async () => {
    // No third step. The response to the upload is the final state of the record: it is
    // `ready` or `rejected`, never `ready` with bytes nobody looked at (§21.1).
    const reserved = await reserve();
    const response = await upload(reserved.id, PNG(512));
    expect(response.status).toBe(200);

    const media = (await response.json()) as MediaView;
    expect(media.status).toBe("ready");
    expect(media.content_type).toBe("image/png");
    expect(media.byte_size).toBe(512);
    expect(media.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(media.url).toBe(`${MEDIA}/${media.id}/original`);
  });

  it("ignores the Content-Type the client sent, and records what the bytes are", async () => {
    const reserved = await reserve();
    const response = await upload(reserved.id, PNG(), { "content-type": "text/html" });
    expect(((await response.json()) as MediaView).content_type).toBe("image/png");
  });

  it("refuses a file larger than the limit without reading it", async () => {
    const reserved = await reserve();
    const response = await upload(reserved.id, PNG(64), {
      "content-length": String(60 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    expect((await response.json()) as { type: string }).toMatchObject({
      type: "https://orator.space/errors/payload-too-large",
    });
  });

  it("refuses an SVG, and says that is what it refused", async () => {
    const reserved = await reserve();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const response = await upload(reserved.id, svg);

    expect(response.status).toBe(422);
    expect(((await response.json()) as { title: string }).title).toContain("SVG");

    const after = await app.request(`${API}/v1/media/${reserved.id}`, { headers: { authorization: `Bearer ${token}` } }, env);
    expect(((await after.json()) as MediaView).status).toBe("rejected");
  });

  it("refuses bytes without a token", async () => {
    const reserved = await reserve();
    const response = await app.request(
      `${API}/v1/media/${reserved.id}/content`,
      { method: "PUT", headers: { "content-length": "256" }, body: PNG() },
      env,
    );
    expect(response.status).toBe(401);
  });
});

describe("the media host (SPEC §57.4)", () => {
  let ready: MediaView;

  beforeAll(async () => {
    const reserved = await reserve();
    ready = (await (await upload(reserved.id, PNG(1024))).json()) as MediaView;
  });

  it("hands back the same bytes that were sent", async () => {
    const response = await app.request(`${MEDIA}/${ready.id}/original`, {}, env);
    expect(response.status).toBe(200);

    const back = new Uint8Array(await response.arrayBuffer());
    expect(back.byteLength).toBe(1024);
    expect([...back.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(back[1023]).toBe(1023 & 0xff);
  });

  it("sends the headers that make an isolated origin worth having", async () => {
    const response = await app.request(`${MEDIA}/${ready.id}/original`, {}, env);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("serves a PDF as an attachment rather than a document the browser opens", async () => {
    const reserved = await reserve("document");
    const pdf = new Uint8Array(256);
    pdf.set([..."%PDF-1.7"].map((c) => c.charCodeAt(0)), 0);
    const media = (await (await upload(reserved.id, pdf)).json()) as MediaView;
    expect(media.content_type).toBe("application/pdf");

    const response = await app.request(`${MEDIA}/${media.id}/original`, {}, env);
    expect(response.headers.get("content-disposition")).toContain("attachment");
  });

  it("does not serve media from the API host", async () => {
    // The whole of §57.4 is this line. Without the host check the same path answers on
    // api.orator.space, and user-controlled bytes are served from the origin that holds
    // the session — which is the thing the separate origin exists to prevent.
    const response = await app.request(`${API}/${ready.id}/original`, {}, env);
    expect(response.status).toBe(404);
  });

  it("does not serve a record that never got its bytes", async () => {
    const reserved = await reserve();
    const response = await app.request(`${MEDIA}/${reserved.id}/original`, {}, env);
    expect(response.status).toBe(404);
  });

  it("does not serve a rejected one", async () => {
    const reserved = await reserve();
    await upload(reserved.id, new TextEncoder().encode("MZ not an image at all"));
    const response = await app.request(`${MEDIA}/${reserved.id}/original`, {}, env);
    expect(response.status).toBe(404);
  });

  it("knows only the original, so a guessed variant is not a hole", async () => {
    const response = await app.request(`${MEDIA}/${ready.id}/../../etc`, {}, env);
    expect(response.status).toBe(404);
  });
});

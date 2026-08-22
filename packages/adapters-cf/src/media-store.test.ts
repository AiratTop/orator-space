import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createR2MediaStore } from "./media-store.js";

/**
 * The streamed upload against a real bucket (SPEC §21.1, ADR 0005).
 *
 * This file is the reason the decision could be made at all. The design rests on three
 * runtime facts — that `crypto.DigestStream` exists, that R2 will take a stream, and on
 * what terms — and only one of those survived contact: the first draft used `tee()`, one
 * branch to the digest and one to R2, and R2 refused it outright because `put()` requires
 * a stream of known length. A double would have agreed with whatever it was told.
 *
 * The refusal tests print `Network connection lost` to stderr. That is workerd tearing
 * down the aborted R2 upload, not an unobserved rejection in this code — vitest reports no
 * unhandled errors, and it stops appearing if the refusals are removed.
 */

const store = createR2MediaStore(env.MEDIA, "test-media/");

const streamOf = (bytes: Uint8Array, chunkSize = 64 * 1024): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.byteLength; at += chunkSize) {
        controller.enqueue(bytes.subarray(at, Math.min(at + chunkSize, bytes.byteLength)));
      }
      controller.close();
    },
  });

const fileOf = (size: number, header: number[] = [0x89, 0x50, 0x4e, 0x47]): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set(header, 0);
  for (let i = header.length; i < size; i++) bytes[i] = i & 0xff;
  return bytes;
};

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("one streamed pass", () => {
  it("stores the bytes and reports what went past", async () => {
    const bytes = fileOf(3 * 1024 * 1024);
    const outcome = await store.put("one", streamOf(bytes), bytes.byteLength);

    expect(outcome.byteSize).toBe(bytes.byteLength);
    expect([...outcome.leading.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // The hash is the one thing here that cannot be checked by reading it back, since
    // reading it back would use the same code. Compared against Web Crypto over the whole
    // buffer instead — the answer the streaming digest has to agree with.
    expect(outcome.sha256).toBe(hex(await crypto.subtle.digest("SHA-256", bytes)));
  });

  it("stores what it was given, not a truncation of it", async () => {
    const bytes = fileOf(3 * 1024 * 1024);
    await store.put("two", streamOf(bytes), bytes.byteLength);

    const read = await store.get("two");
    expect(read?.byteSize).toBe(bytes.byteLength);
    const back = new Uint8Array(await new Response(read!.body).arrayBuffer());
    expect(back.byteLength).toBe(bytes.byteLength);
    expect(back[bytes.byteLength - 1]).toBe(bytes[bytes.byteLength - 1]);
  });

  it("captures the leading bytes across chunk boundaries", async () => {
    // The sniffing window is 64 bytes; a stream delivering one byte at a time must still
    // fill it, or a file arriving in small chunks would be unidentifiable.
    const bytes = fileOf(256);
    await store.put("three", streamOf(bytes, 1), bytes.byteLength);

    const outcome = await store.put("four", streamOf(bytes, 1), bytes.byteLength);
    expect(outcome.leading.byteLength).toBe(64);
    expect([...outcome.leading]).toEqual([...bytes.subarray(0, 64)]);
  });

  it("keeps the whole file even when it is smaller than the sniffing window", async () => {
    const bytes = fileOf(10);
    const outcome = await store.put("five", streamOf(bytes), 10);
    expect(outcome.leading.byteLength).toBe(10);
  });
});

describe("the declared length is the enforcement", () => {
  it("refuses a body shorter than it claimed", async () => {
    const bytes = fileOf(1024);
    await expect(store.put("short", streamOf(bytes), 2048)).rejects.toThrow();
  });

  it("refuses a body longer than it claimed", async () => {
    const bytes = fileOf(4096);
    await expect(store.put("long", streamOf(bytes), 1024)).rejects.toThrow();
  });

  it("leaves nothing behind when it refuses", async () => {
    // A partial object under a key the service believes is free is worse than no object:
    // the record would be retried and the second upload would find the key occupied.
    await store.put("orphan", streamOf(fileOf(1024)), 2048).catch(() => undefined);
    expect(await store.get("orphan")).toBeNull();
  });
});

describe("reading and removing", () => {
  it("returns null for an object that is not there", async () => {
    expect(await store.get("absent")).toBeNull();
  });

  it("deletes, and says nothing about deleting what is absent", async () => {
    await store.put("doomed", streamOf(fileOf(512)), 512);
    await store.delete("doomed");
    expect(await store.get("doomed")).toBeNull();
    await expect(store.delete("doomed")).resolves.toBeUndefined();
  });
});

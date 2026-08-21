import { describe, expect, it } from "vitest";
import { createMemoryContentStore } from "./memory-content-store.js";

describe("content store contract (SPEC §16.2)", () => {
  it("addresses content by its digest, so storing twice is one object", async () => {
    const store = createMemoryContentStore();
    const first = await store.put("# Hello");
    const second = await store.put("# Hello");
    expect(first).toBe(second);
    expect(store.size()).toBe(1);
  });

  it("gives different content different keys", async () => {
    const store = createMemoryContentStore();
    expect(await store.put("a")).not.toBe(await store.put("b"));
    expect(store.size()).toBe(2);
  });

  it("round-trips exactly, including trailing whitespace", async () => {
    const store = createMemoryContentStore();
    const body = "# Title\n\nParagraph with a trailing newline.\n";
    expect(await store.get(await store.put(body))).toBe(body);
  });

  it("returns null rather than throwing for a body that is not there", async () => {
    // Erasure (§23.3) blanks content_ref, so a reader can legitimately meet a missing body.
    expect(await createMemoryContentStore().get("f".repeat(64))).toBeNull();
  });

  it("deletes", async () => {
    const store = createMemoryContentStore();
    const hash = await store.put("x");
    await store.delete(hash);
    expect(await store.get(hash)).toBeNull();
  });
})

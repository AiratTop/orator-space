import { describe, expect, it } from "vitest";
import { createVectorIndex } from "./vectorize.js";

/**
 * What is actually sent to the store (SPEC §38.2, ADR 0012).
 *
 * These are not adapter unit tests for their own sake. The binding's interface is hand-written
 * here, because §28.1 keeps Cloudflare types out of the domain, so nothing checks the options
 * this file passes — and the one that was wrong was wrong in the way that costs most:
 * `returnMetadata` is an enum sitting between two booleans, it was written as `false`, and the
 * store rejects that at query time only, with `VECTOR_QUERY_ERROR (code = 40026)`.
 *
 * Everything else passed. The compiler agreed with the hand-written type, the service's tests
 * passed against a double that accepts whatever it is handed, and the cron drain wrote 581
 * vectors before a single query was tried. §38.2's degradation then hid the failure in
 * production shape: search stayed lexical, answered 200, and left one line in a log.
 *
 * So what these assert is the wire, not the behaviour. A test written before that call could
 * not have known the right value — it would have asserted `false` as confidently as the code
 * did. What it can do is stop the value moving back.
 */

function recordingIndex() {
  const calls: { upsert: unknown[][]; deleted: string[][]; queries: [number[], unknown][] } = {
    upsert: [],
    deleted: [],
    queries: [],
  };
  const binding = {
    async upsert(vectors: { id: string; values: number[] }[]) {
      calls.upsert.push(vectors);
      return {};
    },
    async deleteByIds(ids: string[]) {
      calls.deleted.push(ids);
      return {};
    },
    async query(vector: number[], options: unknown) {
      calls.queries.push([vector, options]);
      return { matches: [{ id: "A1", score: 0.9 }] };
    },
  };
  return { index: createVectorIndex(binding), calls };
}

describe("querying the store", () => {
  it("asks for no metadata by the name the store understands", async () => {
    const { index, calls } = recordingIndex();
    await index.nearest([0.1, 0.2], 40);

    // `"none"`, never `false`. The two are indistinguishable to the compiler here and are not
    // indistinguishable to Vectorize, which rejects the boolean when the first query arrives —
    // long after the corpus has been embedded and every test has passed.
    expect(calls.queries[0]?.[1]).toEqual({ topK: 40, returnValues: false, returnMetadata: "none" });
  });

  it("returns the id and the score, and nothing else the caller could come to rely on", async () => {
    const { index } = recordingIndex();
    // Metadata is deliberately not requested: §38.2 keeps article state in D1, and `search`
    // re-reads every result there. A copy here is the copy that goes stale.
    expect(await index.nearest([0.1], 10)).toEqual([{ articleId: "A1", score: 0.9 }]);
  });
});

describe("writing to the store", () => {
  it("sends the article id as the vector's id, so a rewrite replaces rather than accumulates", async () => {
    const { index, calls } = recordingIndex();
    await index.upsert([{ articleId: "A1" as never, vector: [0.1, 0.2] }]);
    expect(calls.upsert[0]).toEqual([{ id: "A1", values: [0.1, 0.2] }]);
  });

  it("chunks a batch larger than the store is asked for in one call", async () => {
    const { index, calls } = recordingIndex();
    const entries = Array.from({ length: 250 }, (_, i) => ({
      articleId: `A${i}` as never,
      vector: [i],
    }));
    await index.upsert(entries);

    expect(calls.upsert.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
  });

  it("deletes nothing when asked to delete nothing", async () => {
    const { index, calls } = recordingIndex();
    await index.remove([]);
    // An empty delete is a round trip that can only fail. The removal path runs on every
    // article event that is not a publish, so "nothing to do" is the common case.
    expect(calls.deleted).toEqual([]);
  });

  it("chunks a delete the same way", async () => {
    const { index, calls } = recordingIndex();
    await index.remove(Array.from({ length: 150 }, (_, i) => `A${i}`));
    expect(calls.deleted.map((chunk) => chunk.length)).toEqual([100, 50]);
  });
});

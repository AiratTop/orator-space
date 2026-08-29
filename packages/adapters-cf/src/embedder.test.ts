import { describe, expect, it } from "vitest";
import { createWorkersAiEmbedder } from "./embedder.js";

/**
 * Reading what the embedding model actually returns (SPEC §38.2, ADR 0012).
 *
 * The shape below is observed, not assumed: `{ text: string[] }` in, `{ data, shape: [n, 1024],
 * pooling: "cls" }` out, vectors already L2-normalised. Verified against the account on
 * 2026-08-29, because §22.3's history in this repository is that a model id and its wire format
 * are configuration only a real call can check.
 *
 * This parser is deliberately strict where `classifier.test.ts` documents a forgiving one, and
 * the difference is not inconsistency. A sloppy parse of a classification proposes a slug that
 * the closed vocabulary then discards — there is a check downstream. A sloppy parse of an
 * embedding produces a shorter array that the store accepts or a wrong one that it does not,
 * and there is no downstream check to be forgiving on behalf of. Silence is the failure mode
 * that matters here: a vector of the wrong width matches nothing, for ever, quietly.
 */

const answering = (result: unknown) => ({ run: async () => result });
const vector = (n: number) => Array.from({ length: n }, (_, i) => i / n);

describe("reading a model's vectors", () => {
  it("reads the shape the model returns", async () => {
    const embedder = createWorkersAiEmbedder(answering({ data: [vector(4)], shape: [1, 4] }), "m", 4);
    expect(await embedder.embed(["one"])).toEqual([vector(4)]);
  });

  it("keeps the order it was given, because the caller matches by position", async () => {
    const embedder = createWorkersAiEmbedder(
      answering({ data: [[1, 0, 0, 0], [0, 1, 0, 0]] }),
      "m",
      4,
    );
    expect(await embedder.embed(["first", "second"])).toEqual([[1, 0, 0, 0], [0, 1, 0, 0]]);
  });

  it("asks nothing of the model when given nothing", async () => {
    let called = false;
    const embedder = createWorkersAiEmbedder({
      run: async () => {
        called = true;
        return {};
      },
    });
    expect(await embedder.embed([])).toEqual([]);
    expect(called).toBe(false);
  });

  it("names the model in its own name, so a stale vector can be found later", () => {
    // The ledger stores this string and the backlog drain selects on it; changing the model is
    // therefore a configuration change rather than a migration (§38.2).
    expect(createWorkersAiEmbedder(answering({}), "@cf/x/y").name).toBe("workers-ai:@cf/x/y");
  });
});

describe("what it refuses rather than passes on", () => {
  it("a response carrying no data array", async () => {
    const embedder = createWorkersAiEmbedder(answering({ response: "sorry" }), "m", 4);
    await expect(embedder.embed(["one"])).rejects.toThrow(/no data array/);
  });

  /*
   * Fewer vectors than inputs is the dangerous one.
   *
   * The caller matches vectors to texts by position, so a short answer does not fail — it
   * silently attributes one article's vector to another. Refusing is what makes §38.2's
   * degradation apply: the service records nothing and the next event tries again.
   */
  it("fewer vectors than it was given texts", async () => {
    const embedder = createWorkersAiEmbedder(answering({ data: [vector(4)] }), "m", 4);
    await expect(embedder.embed(["one", "two"])).rejects.toThrow(/1 vectors for 2 inputs/);
  });

  it("a vector that is not numbers", async () => {
    const embedder = createWorkersAiEmbedder(answering({ data: [["a", "b"]] }), "m", 4);
    await expect(embedder.embed(["one"])).rejects.toThrow(/non-numeric/);
  });
});

describe("what it sends", () => {
  it("asks the model to truncate rather than throw on an oversized input", async () => {
    let seen: Record<string, unknown> | undefined;
    const embedder = createWorkersAiEmbedder(
      {
        run: async (_model: string, input: Record<string, unknown>) => {
          seen = input;
          return { data: [vector(4)] };
        },
      },
      "m",
      4,
    );
    await embedder.embed(["one"]);

    // The service already cuts the body well inside the model's context, so this should never
    // fire. It is set because the alternative when it would have fired is one article that can
    // never be embedded, failing identically on every cron run for ever.
    expect(seen).toEqual({ text: ["one"], truncate_inputs: true });
  });
});

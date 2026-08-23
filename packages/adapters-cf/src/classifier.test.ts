import { describe, expect, it } from "vitest";
import { createWorkersAiClassifier } from "./classifier.js";
import { createWorkersAiModerator } from "./moderator.js";

/**
 * Parsing what a small model actually returns (SPEC §22.3, §61).
 *
 * These are not adapter unit tests for their own sake. The strings below are what Workers AI
 * returned on the first live call, and the shape that matters is the one nobody expects: the
 * model stopped before closing its outer brace. A parser that required valid JSON read that
 * as an empty answer, which the service records as "nothing fits" and never retries — so a
 * working model would have quietly unclassified every article on the platform.
 */

const answering = (response: string) => ({
  run: async () => ({ response }),
});

const input = { title: "t", body: "b", vocabulary: [{ slug: "llm", label: "LLM", description: null }] };

describe("reading a classifier's answer", () => {
  it("reads the well-formed case", async () => {
    const classifier = createWorkersAiClassifier(
      answering('{"topics":[{"slug":"llm","confidence":0.9}]}'),
    );
    expect(await classifier.classify(input)).toEqual([{ slug: "llm", confidence: 0.9 }]);
  });

  it("reads an answer the model never closed", async () => {
    // Verbatim from the first live call, closing brace and all missing.
    const classifier = createWorkersAiClassifier(
      answering(
        '{"topics":[{"slug":"inference","confidence":0.8},{"slug":"agents","confidence":0.1},{"slug":"history","confidence":0.1}]',
      ),
    );
    expect((await classifier.classify(input)).map((c) => c.slug)).toEqual([
      "inference",
      "agents",
      "history",
    ]);
  });

  it("reads an answer wrapped in prose", async () => {
    const classifier = createWorkersAiClassifier(
      answering('Here you go:\n```json\n{"topics":[{"slug":"llm","confidence":0.7}]}\n```'),
    );
    expect(await classifier.classify(input)).toEqual([{ slug: "llm", confidence: 0.7 }]);
  });

  it("treats a missing score as a choice rather than as a refusal", async () => {
    const classifier = createWorkersAiClassifier(answering('{"topics":[{"slug":"llm"}]}'));
    // The service's threshold is what decides; discarding it here would take that decision
    // away from the one place that makes it.
    expect(await classifier.classify(input)).toEqual([{ slug: "llm", confidence: 1 }]);
  });

  it("returns nothing for an answer with no topics in it", async () => {
    const classifier = createWorkersAiClassifier(answering("I cannot help with that."));
    expect(await classifier.classify(input)).toEqual([]);
  });
});

describe("reading a moderation verdict", () => {
  const content = { title: "t", body: "b" };
  const context = { authorKind: "agent" as const, trustLevel: 1 };

  it("allows a clean article", async () => {
    const provider = createWorkersAiModerator(answering('{"categories":[],"severity":0}'));
    const verdict = await provider.check(content, context);
    expect(verdict.action).toBe("allow");
    expect(verdict.categories).toEqual([]);
  });

  it("flags at severity, and names only categories it was given", async () => {
    const provider = createWorkersAiModerator(
      answering('{"categories":["spam","astrology"],"severity":0.9}'),
    );
    const verdict = await provider.check(content, context);
    expect(verdict.action).toBe("flag");
    expect(verdict.categories).toEqual(["spam"]);
  });

  it("does not flag a category named with a low severity", async () => {
    const provider = createWorkersAiModerator(answering('{"categories":["spam"],"severity":0.2}'));
    // A signal below the bar is a signal, not a report. §61 keeps a single weak hit under
    // the threshold precisely so the queue stays worth reading.
    expect((await provider.check(content, context)).action).toBe("allow");
  });

  it("never returns anything stronger than a flag", async () => {
    const provider = createWorkersAiModerator(
      answering('{"categories":["illegal"],"severity":1,"action":"block","remove":true}'),
    );
    // §61 gives an automatic verdict exactly one action. A model asking for more gets no
    // more, because the shape of the return value does not have a way to say it.
    expect((await provider.check(content, context)).action).toBe("flag");
  });
});

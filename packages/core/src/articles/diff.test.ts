import { describe, expect, it } from "vitest";
import { diffLines, MAX_DIFF_LINES, withContext } from "./diff.js";

/**
 * The difference between two revisions (SPEC §16.1, §49.2).
 *
 * A diff is one of the few pieces of this system where "looks about right" is not a check:
 * a reader is being told what an author changed, and an algorithm that drops a removed line
 * or attributes an added one to the wrong side is making a false statement about somebody's
 * work. So the assertions are about the operations, not about the rendering.
 */

const text = (...lines: string[]) => lines.join("\n");

describe("what changed", () => {
  it("says nothing changed when nothing did", () => {
    const diff = diffLines(text("one", "two"), text("one", "two"));
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.lines.every((line) => line.op === "same")).toBe(true);
  });

  it("finds an inserted line without disturbing the ones around it", () => {
    const diff = diffLines(text("one", "three"), text("one", "two", "three"));

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
    expect(diff.lines.map((line) => line.op)).toEqual(["same", "added", "same"]);
    expect(diff.lines[1]).toMatchObject({ text: "two", before: null, after: 2 });
  });

  it("finds a removed line", () => {
    const diff = diffLines(text("one", "two", "three"), text("one", "three"));
    expect(diff.removed).toBe(1);
    expect(diff.lines.map((line) => line.op)).toEqual(["same", "removed", "same"]);
  });

  it("reports an edited line as one removal and one addition", () => {
    // A line-based diff has no other vocabulary, and pretending otherwise — "changed" — would
    // hide which text was there before, which is the thing a reader came to see.
    const diff = diffLines(text("the latency was 40ms"), text("the latency was 60ms"));
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.map((line) => line.text)).toContain("the latency was 40ms");
    expect(diff.lines.map((line) => line.text)).toContain("the latency was 60ms");
  });

  it("keeps the line numbers of each side separate", () => {
    // The two columns a reader reads: where the line was, and where it is. An added line has
    // no place in the old text and a removed one has none in the new.
    const diff = diffLines(text("a", "b", "c"), text("a", "x", "b", "c"));
    const added = diff.lines.find((line) => line.op === "added");
    expect(added).toMatchObject({ before: null, after: 2 });
    const same = diff.lines.filter((line) => line.op === "same");
    expect(same.map((line) => [line.before, line.after])).toEqual([
      [1, 1],
      [2, 3],
      [3, 4],
    ]);
  });

  it("handles an empty document on either side", () => {
    expect(diffLines("", text("one", "two")).added).toBe(2);
    expect(diffLines(text("one", "two"), "").removed).toBe(2);
  });

  it("treats CRLF and LF as the same text", () => {
    // A revision written on Windows and one written anywhere else are not a rewrite of every
    // line, which is what a naive split would report.
    const diff = diffLines("one\r\ntwo", "one\ntwo");
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it("refuses to compare two very long documents rather than trying", () => {
    // The table is O(n·m); §40's memory limit is the reason this has an answer at all.
    const long = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
    const diff = diffLines(long, long);
    expect(diff.tooLarge).toBe(true);
    expect(diff.lines).toEqual([]);
  });
});

describe("the unchanged middle", () => {
  it("is dropped, and the changes keep their context", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 20", "line twenty");

    const hunks = withContext(diffLines(before, after).lines, 2);

    expect(hunks).toHaveLength(1);
    // Two lines either side of the change, plus the removal and the addition.
    expect(hunks[0]).toHaveLength(6);
    expect(hunks[0]?.map((line) => line.text)).toContain("line 19");
    expect(hunks[0]?.map((line) => line.text)).toContain("line 21");
  });

  it("splits into separate hunks when the changes are far apart", () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 5", "five").replace("line 50", "fifty");

    expect(withContext(diffLines(before, after).lines, 2)).toHaveLength(2);
  });

  it("is empty when nothing changed, so a page can say so", () => {
    expect(withContext(diffLines("same", "same").lines)).toEqual([]);
  });
});

/**
 * What changed between two revisions (SPEC §16.1, §49.2).
 *
 * The platform stores immutable revisions and signs them (§16.1, §41), which makes a public
 * history worth more here than on an ordinary site: a reader can see not only that an
 * article changed but who changed it and whether the new text carries the same signature.
 * None of that is legible as two blocks of prose side by side, so the difference is computed.
 *
 * **Line-based, and by the longest common subsequence.** Markdown is written in lines and
 * read in paragraphs; a word-level diff of prose produces a speckle nobody reads. LCS is the
 * textbook answer and about thirty lines, which is the argument for having no dependency:
 * a diff library is a large surface for a problem this size, and this one is exercised by
 * tests rather than trusted.
 *
 * **Bounded.** The table is O(n·m) in memory, so two long revisions would cost megabytes in
 * a Worker with 128 MB and a wall clock (§40). Past the cap the answer is "too large to
 * compare here", which is honest and leaves both revisions readable in full.
 */

export type DiffOp = "same" | "added" | "removed";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the older text, where the line exists in it. */
  before: number | null;
  /** 1-based line number in the newer text, where the line exists in it. */
  after: number | null;
}

export interface Diff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the texts were too long to compare; `lines` is then empty. */
  tooLarge: boolean;
}

/**
 * The ceiling, in lines per side.
 *
 * Two thousand lines is far longer than anything §16.2's size limit admits as an article and
 * still only four million cells at the worst case — well inside what a Worker can hold for
 * the moment it takes. The cap exists so the failure is a message rather than an eviction.
 */
export const MAX_DIFF_LINES = 2_000;

const split = (text: string): string[] => text.replace(/\r\n/g, "\n").split("\n");

export function diffLines(before: string, after: string): Diff {
  const a = split(before);
  const b = split(after);

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { lines: [], added: 0, removed: 0, tooLarge: true };
  }

  /*
   * The LCS table, built from the end backwards.
   *
   * `table[i][j]` is the length of the longest common subsequence of `a[i…]` and `b[j…]`.
   * Walking it forwards afterwards yields the operations in reading order, which is what a
   * page renders — reconstructing from the front would give them reversed and require a
   * second pass to fix.
   */
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: "same", text: a[i]!, before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ op: "removed", text: a[i]!, before: i + 1, after: null });
      removed += 1;
      i += 1;
    } else {
      lines.push({ op: "added", text: b[j]!, before: null, after: j + 1 });
      added += 1;
      j += 1;
    }
  }
  while (i < a.length) {
    lines.push({ op: "removed", text: a[i]!, before: i + 1, after: null });
    removed += 1;
    i += 1;
  }
  while (j < b.length) {
    lines.push({ op: "added", text: b[j]!, before: null, after: j + 1 });
    added += 1;
    j += 1;
  }

  return { lines, added, removed, tooLarge: false };
}

/**
 * Drops the unchanged middle of a long run (the "…" a reader expects).
 *
 * A revision that fixed a typo is otherwise a thousand identical lines with two coloured ones
 * somewhere inside, and the change is what somebody came to see. Context is kept either side
 * of every change so the line has a place in the text rather than floating.
 */
export function withContext(lines: readonly DiffLine[], context = 3): DiffLine[][] {
  const interesting = lines
    .map((line, index) => (line.op === "same" ? -1 : index))
    .filter((index) => index >= 0);
  if (interesting.length === 0) return [];

  const hunks: DiffLine[][] = [];
  let start = Math.max(0, interesting[0]! - context);
  let end = Math.min(lines.length - 1, interesting[0]! + context);

  for (const index of interesting.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(lines.length - 1, index + context);
      continue;
    }
    hunks.push(lines.slice(start, end + 1));
    start = Math.max(0, index - context);
    end = Math.min(lines.length - 1, index + context);
  }
  hunks.push(lines.slice(start, end + 1));
  return hunks;
}

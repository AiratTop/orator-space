import { countInvisible } from "../text/invisible.js";

/**
 * The moderation provider that ships with the platform (SPEC §61, §58.2).
 *
 * §61 abstracts the provider so that a model, a service or a human can occupy the same
 * slot, and it forbids the mandatory path depending on self-hosted infrastructure. This one
 * runs inside the Worker and depends on nothing at all, which makes it the floor rather
 * than the ceiling: it is what remains true when every external service is unreachable.
 *
 * What it looks for is deliberately narrow. It does not attempt to judge whether an article
 * is good, true or on-topic — no rule-based system can, and one that pretends to would
 * flag honest work and teach a moderator to ignore the queue. It looks for the four things
 * that are mechanically visible in the text and that §58.2 and §60.1 name outright:
 *
 *   1. instructions addressed to a machine that is not the reader's own (§58.1)
 *   2. text hidden from a human but present for a model (§58.2)
 *   3. link farming
 *   4. bulk repetition
 *
 * **It never blocks publishing.** §61 makes moderation asynchronous and after the fact, and
 * §60.1 says the same of duplicate detection: false positives are inevitable, and a false
 * positive that silently refuses to publish somebody's work is worse than one that puts a
 * row in a queue a person reads.
 */

export interface ModerationVerdict {
  /** `flag` raises a report; nothing here ever returns `block` (§61). */
  action: "allow" | "flag";
  /** What was found, as stable codes a moderator's tooling can group by. */
  categories: string[];
  /** 0 to 1. Not a probability — a rank, so a queue can be read worst-first. */
  score: number;
  /** Which provider produced this, recorded so a verdict can be re-read in context. */
  provider: string;
}

/**
 * Phrases that address a machine rather than a reader (SPEC §58.1).
 *
 * The list is short and literal on purpose. An injection has to be understood by a model to
 * work, which means it has to be written in something close to plain language — so plain
 * language is where it is visible. A cleverer matcher would catch more paraphrases and
 * would also start flagging articles *about* prompt injection, which are exactly the
 * articles this network should want.
 *
 * That is why a hit is a signal and not a verdict: §58.2 item 6 says scanning is "a
 * moderation signal, not a block on publishing", and an article discussing these phrases
 * is indistinguishable from one deploying them without reading the surrounding argument.
 */
const ADDRESSED_TO_A_MODEL: readonly RegExp[] = [
  /\bignore (all |any |your )?(previous|prior|above|earlier) (instructions|prompts?|rules|context)\b/i,
  /\bdisregard (all |any |your )?(previous|prior|above|earlier)\b/i,
  /\byou are now\b[^.]{0,60}\b(assistant|model|ai|agent|dan|developer mode)\b/i,
  /\b(system|developer) prompt\b[^.]{0,40}\b(is|was|follows|below|override|reveal|print)\b/i,
  /\bnew instructions?\s*[:：]/i,
  /\b(reveal|print|output|repeat)\b[^.]{0,40}\b(your |the )?(system prompt|instructions|api key|token|secret)\b/i,
  /\bas an? (ai|language model|assistant)\b[^.]{0,40}\byou (must|should|will|are required)\b/i,
  /<\|?(im_start|im_end|endoftext|system)\|?>/i,
  /\[\/?(INST|SYS)\]/,
  /^\s*(assistant|system)\s*[:：]/im,
];

/** A delimiter a participant wrote in order to close somebody's framing early (§47.3). */
const FORGED_BOUNDARY = /<<<[a-z]*:?untrusted[:a-z0-9]*>>>|-{3,}\s*end of (untrusted|user) (content|data)/i;

const LINK = /\[[^\]]*\]\([^)]+\)|https?:\/\/\S+/g;
const WORD = /\p{L}[\p{L}\p{N}'’-]*/gu;

/** Below this, an article is too short for the structural signals to mean anything. */
const MIN_WORDS_FOR_STRUCTURE = 80;

/**
 * Blanks the passages that address a machine (SPEC §22.3, §58.2).
 *
 * The same list the screener flags on, used one step earlier and for a different purpose:
 * before untrusted text is handed to the platform's own model (§58.4), the sentences aimed
 * at it are replaced rather than passed through.
 *
 * This is not a claim to have solved prompt injection, and the difference matters. The list
 * is literal, so a paraphrase walks past it — what it removes is the crude, effective form,
 * which on a first live run was enough to make a classifier put an article about inference
 * latency under `history` because a line in the body told it to. §22.3's ordering is
 * unchanged: this strengthens defence 1, and defence 2 is still what bounds the damage.
 *
 * Replaced with a marker rather than deleted, because the length and the shape of the
 * article should not change under the model's feet, and because a classifier reading
 * `[removed]` learns something true about the text it is sorting.
 */
export function redactMachineAddressed(text: string): string {
  let out = text;
  for (const pattern of ADDRESSED_TO_A_MODEL) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), "[removed]");
  }
  return out;
}

export const HEURISTIC_PROVIDER = "orator-heuristics-v1";

export function screen(content: { title: string; body: string }): ModerationVerdict {
  const text = `${content.title}\n\n${content.body}`;
  const categories: string[] = [];
  let score = 0;

  const injections = ADDRESSED_TO_A_MODEL.filter((pattern) => pattern.test(text)).length;
  if (injections > 0) {
    categories.push("prompt_injection");
    // Several distinct phrasings is a much stronger signal than one, which an article
    // about the subject would also contain.
    score = Math.max(score, injections === 1 ? 0.4 : 0.8);
  }

  if (FORGED_BOUNDARY.test(text)) {
    // Writing a delimiter that looks like the platform's own framing has one purpose:
    // ending the untrusted block early so the rest reads as instructions (§47.3, §58.2).
    categories.push("forged_boundary");
    score = Math.max(score, 0.9);
  }

  /*
   * Text present for a model and absent for a person (§58.2).
   *
   * The renderer strips these, so they never reach a reader — which is precisely why their
   * presence in the stored text is worth reporting rather than ignoring. Nobody types a
   * zero-width joiner into an article about cold starts by accident, and the one delivery
   * mechanism §58.2 calls primary is the one no reviewer can see.
   */
  const invisible = countInvisible(text);
  if (invisible > 0) {
    categories.push("hidden_text");
    score = Math.max(score, invisible > 8 ? 0.8 : 0.5);
  }

  const words = (content.body.match(WORD) ?? []).length;
  if (words >= MIN_WORDS_FOR_STRUCTURE) {
    const links = (content.body.match(LINK) ?? []).length;
    // One link per twenty words is dense for prose and ordinary for a link farm.
    if (links >= 10 && links / words > 0.05) {
      categories.push("link_farming");
      score = Math.max(score, 0.6);
    }

    const lines = content.body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 20);
    const distinct = new Set(lines).size;
    if (lines.length >= 10 && distinct / lines.length < 0.4) {
      categories.push("bulk_repetition");
      score = Math.max(score, 0.5);
    }
  }

  return {
    // 0.5 is the threshold rather than "anything found": a single injection-shaped phrase
    // scores 0.4 precisely so that writing *about* injection does not fill the queue.
    action: score >= 0.5 ? "flag" : "allow",
    categories,
    score,
    provider: HEURISTIC_PROVIDER,
  };
}

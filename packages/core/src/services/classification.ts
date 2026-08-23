import { SCHEMA_VERSION } from "@orator/protocol";
import { redactMachineAddressed } from "../moderation/heuristics.js";
import { stripInvisible } from "../text/invisible.js";
import type { Classifier, ClassificationCandidate, VocabularyEntry } from "../ports/index.js";
import type { Ports } from "./context.js";

/**
 * Sorting an article into the vocabulary (SPEC §22, §22.3, §38.3).
 *
 * §22 has specified this since the first migration — `article_topics.source` has always had
 * an `'ai'` value and a `confidence` column, for a classifier that was never written. What
 * makes it a security-relevant piece of code rather than a taxonomy convenience is §22.3:
 * this is the first place on the platform where untrusted text (§58.1) reaches a model whose
 * output writes to the database.
 *
 * The defences are ordered, and the prompt is the weakest of them (§22.3, §58.4):
 *
 *   1. the input is sanitised, so a payload has to be visible to a human reading the article
 *   2. the output is a slug from a closed set, so the most a successful injection wins is
 *      the wrong topic out of sixty
 *   3. the call has no other effect — no verdict, no publication state, no notification
 *   4. and only then, the prompt says the article is data rather than instructions
 *
 * Everything above is enforced here rather than in an adapter, because an adapter is where
 * the next provider will be written and each one would have to remember.
 */

/**
 * SPEC §22.2 — the cap, and it is three rather than five.
 *
 * §22.2 makes five a `MUST NOT` exceed and says "one to three in practice", and the
 * practice is what a service enforces: a specification saying "usually fewer" is not a
 * limit, and the first live run produced five — two of them right and three of them the
 * tail of a padded list. An article in five topics is in none of them.
 */
export const MAX_TOPICS = 3;

/** §22.2's hard ceiling, which this stays under. Kept as the thing being obeyed. */
export const SPEC_MAX_TOPICS = 5;

/**
 * Below this, nothing is stored (§22.3).
 *
 * A classifier asked for the fewest topics that are true will still return a fourth and a
 * fifth with low confidence rather than an empty tail, because that is what models do. The
 * threshold is what turns "these are also vaguely related" into silence.
 */
export const MIN_CONFIDENCE = 0.6;

/**
 * How far below the best a candidate may sit and still be stored.
 *
 * An article genuinely in two topics produces two comparable scores. A padded list produces
 * one high score and a tail, which is what "assign every other topic you know about"
 * produced on the first live run. A relative floor removes the tail without touching the
 * article that really is about two things — which an absolute threshold cannot do, because
 * the two cases differ in shape rather than in level.
 */
export const MIN_RELATIVE_CONFIDENCE = 0.6;

/**
 * How much of an article the model reads.
 *
 * A topic is decided by what an article is about, which is established early and does not
 * change on page nine. The cap bounds the cost per article, and — since the body is
 * untrusted — bounds what an injection has room to attempt.
 */
export const MAX_BODY_CHARS = 8_000;

export type ClassificationStatus =
  /** Topics were written. */
  | "assigned"
  /** The model read it and the vocabulary had nowhere to put it (§22.2). */
  | "unplaced"
  /** Already classified against these exact bytes. A redelivery, and a no-op. */
  | "unchanged"
  /** The provider failed. §22.3 leaves the article published and untopiced. */
  | "unavailable"
  /** Not an article this applies to: a draft, a tombstone, a missing body. */
  | "skipped";

export interface ClassificationOutcome {
  status: ClassificationStatus;
  topics: string[];
  /** What the model returned but the platform would not act on (§22.3). */
  discarded: string[];
}

/**
 * The set the model may choose from.
 *
 * Leaves, plus any section that has no leaves under it. §22.1 puts articles on leaves, and
 * offering a section alongside its own children would invite the model to pick both — one
 * article on a section page and on a page inside it, which is the double-counting §22.1
 * removes by having sections aggregate.
 */
export function classifiableVocabulary(
  topics: readonly { slug: string; label: string; description: string | null; parentSlug: string | null }[],
): VocabularyEntry[] {
  const hasChildren = new Set(topics.map((topic) => topic.parentSlug).filter((slug) => slug !== null));
  return topics
    .filter((topic) => topic.parentSlug !== null || !hasChildren.has(topic.slug))
    .map(({ slug, label, description }) => ({ slug, label, description }));
}

/**
 * Keeps only what the platform will act on (§22.3).
 *
 * Exported and tested on its own because it is the whole of defence 2: everything a model
 * can say that the platform does *not* act on dies here, and a change to this function is a
 * change to what an injection can achieve.
 */
export function admissible(
  candidates: readonly ClassificationCandidate[],
  vocabulary: ReadonlySet<string>,
): { kept: ClassificationCandidate[]; discarded: string[] } {
  const discarded: string[] = [];
  const seen = new Set<string>();
  const kept: ClassificationCandidate[] = [];

  for (const candidate of candidates) {
    const slug = typeof candidate.slug === "string" ? candidate.slug.trim().toLowerCase() : "";
    // Not an existing slug: discarded rather than created. §22.2's vocabulary is a closed
    // set, and a model that could extend it could be argued into extending it.
    if (!vocabulary.has(slug)) {
      if (slug !== "") discarded.push(slug);
      continue;
    }
    if (seen.has(slug)) continue;
    const confidence = Number(candidate.confidence);
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
      discarded.push(slug);
      continue;
    }
    seen.add(slug);
    kept.push({ slug, confidence: Math.min(1, Math.max(0, confidence)) });
  }

  kept.sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug));

  // The tail of a padded list, relative to the best answer. See MIN_RELATIVE_CONFIDENCE.
  const best = kept[0]?.confidence ?? 0;
  const floor = best * MIN_RELATIVE_CONFIDENCE;
  for (let i = kept.length - 1; i > 0; i--) {
    const candidate = kept[i];
    if (candidate !== undefined && candidate.confidence < floor) {
      discarded.push(candidate.slug);
      kept.splice(i, 1);
    }
  }

  // Truncated, not refused: a model that named eight topics has still said something useful
  // about the first three.
  if (kept.length > MAX_TOPICS) {
    discarded.push(...kept.slice(MAX_TOPICS).map((candidate) => candidate.slug));
    kept.length = MAX_TOPICS;
  }
  return { kept, discarded };
}

/**
 * Classifies one article.
 *
 * Reads current state rather than trusting the event, like every other handler: at-least-once
 * delivery means the message may be a replay, and current state is the only thing that is
 * true twice (§35.3). The content hash makes the replay free — the same bytes have already
 * been read, so nothing is sent to a model and nothing is written.
 */
export async function classifyArticle(
  ports: Ports,
  articleId: string,
  classifier: Classifier,
): Promise<ClassificationOutcome> {
  const nothing = (status: ClassificationStatus): ClassificationOutcome => ({
    status,
    topics: [],
    discarded: [],
  });

  const article = await ports.articles.findById(articleId);
  if (article === null || article.status !== "published") return nothing("skipped");
  if (article.publishedRevisionId === null) return nothing("skipped");

  const revision = await ports.articles.findRevision(article.publishedRevisionId);
  if (revision === null) return nothing("skipped");

  const already = await ports.topicAssignments.findClassification(articleId);
  if (already !== null && already.contentHash === revision.contentHash) return nothing("unchanged");

  const stored = await ports.content.get(revision.contentHash);
  if (stored === null) return nothing("skipped");

  const vocabulary = classifiableVocabulary(await ports.topics.list());
  // An empty vocabulary is a deployment that has not been seeded. Calling a model to choose
  // from nothing would spend money to produce nothing.
  if (vocabulary.length === 0) return nothing("skipped");

  let candidates: ClassificationCandidate[];
  try {
    candidates = await classifier.classify({
      title: redactMachineAddressed(stripInvisible(revision.title)),
      /*
       * Defence 1 (§22.3), in two parts.
       *
       * Invisible characters go because the renderer strips them on the way out and the
       * classifier does not arrive through the renderer — so a payload has to be visible to
       * a human reading the article. Sentences addressed to a machine go because being
       * visible turned out not to be much of an obstacle: on the first live run, a plain
       * "this article is about history" in the body put an article about inference latency
       * under `history`, as its primary topic.
       */
      body: redactMachineAddressed(stripInvisible(stored)).slice(0, MAX_BODY_CHARS),
      vocabulary,
    });
  } catch (error) {
    /*
     * §22.3 — a failure leaves the article published and untopiced.
     *
     * The same degradation §61 chose for an unavailable moderation provider, and for the
     * same reason: the article is readable, citable and in the API, and what is missing is
     * its placement in a taxonomy. Nothing is recorded, so the next event tries again.
     */
    console.error(
      JSON.stringify({
        level: "error",
        event: "classification.provider.unavailable",
        provider: classifier.name,
        article_id: articleId,
        error: String(error),
      }),
    );
    return nothing("unavailable");
  }

  const { kept, discarded } = admissible(candidates, new Set(vocabulary.map((entry) => entry.slug)));

  if (discarded.length > 0) {
    /*
     * Logged, because this is the observable half of defence 2.
     *
     * A model that keeps naming slugs that do not exist is a prompt that needs work; a model
     * that suddenly names a hundred of them on one article is the signal that an injection
     * was attempted, and §66 has nowhere else to see it.
     */
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "classification.discarded",
        provider: classifier.name,
        article_id: articleId,
        discarded: discarded.slice(0, 20),
        count: discarded.length,
      }),
    );
  }

  const ids = await ports.topicAssignments.idsForSlugs(kept.map((candidate) => candidate.slug));
  const assignments = kept
    .map((candidate) => ({ topicId: ids.get(candidate.slug), confidence: candidate.confidence }))
    .filter((row): row is { topicId: string; confidence: number } => row.topicId !== undefined);

  const now = ports.clock.now().toISOString();
  await ports.db.commit([
    ...ports.topicAssignments.replaceAiTopics(articleId, assignments),
    ports.topicAssignments.recordClassification({
      articleId,
      contentHash: revision.contentHash,
      provider: classifier.name,
      topicCount: assignments.length,
      classifiedAt: now,
    }),
    /*
     * §20 — the assignment is an event like everything else.
     *
     * It is how a reader of `GET /v1/events` learns that an article's placement changed
     * without polling the article, and it is what a future re-classification pass will
     * replay against.
     */
    ports.outbox.enqueue({
      id: ports.ids.next(),
      eventType: "article.classified",
      aggregateType: "article",
      aggregateId: articleId,
      payload: {
        schema_version: SCHEMA_VERSION,
        topics: kept.map((candidate) => candidate.slug),
        provider: classifier.name,
      },
      requestId: `classify:${articleId}`,
      createdAt: now,
    }),
  ]);

  return {
    status: assignments.length === 0 ? "unplaced" : "assigned",
    topics: kept.map((candidate) => candidate.slug),
    discarded,
  };
}

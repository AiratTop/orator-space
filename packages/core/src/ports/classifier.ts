/**
 * Automatic classification (SPEC §22.3, §38.3, §58.4).
 *
 * A port rather than a call, for the reason §61 gives about moderation: the implementation
 * will be a hosted model today and something else later, and the domain must not know which.
 * What the domain does know is the shape of the exchange — a closed vocabulary in, a slug or
 * nothing out — and that shape is the security property, not a convenience (§22.3).
 */

/** One entry of the closed set the model may choose from. */
export interface VocabularyEntry {
  slug: string;
  label: string;
  /** The same sentence a reader sees on the topic page (§22.2). */
  description: string | null;
}

export interface ClassificationInput {
  title: string;
  /**
   * The article, sanitised (§57.1) and truncated by the caller.
   *
   * Sanitised because this is the first place untrusted text reaches a model whose output
   * writes to the database (§22.3), and the renderer — which strips invisible characters on
   * the way out — is not on this path.
   */
  body: string;
  vocabulary: readonly VocabularyEntry[];
}

export interface ClassificationCandidate {
  slug: string;
  /** 0 to 1. A provider that cannot produce one reports 1: the caller's threshold decides. */
  confidence: number;
}

export interface Classifier {
  /** Recorded with the result, so a verdict can be re-read knowing what produced it. */
  name: string;
  /**
   * Returns what the model chose. Throwing is the way to report unavailability: §22.3
   * leaves an article published and untopiced, which is a different outcome from an empty
   * array — that means the model read the article and the vocabulary had nowhere to put it.
   */
  classify(input: ClassificationInput): Promise<ClassificationCandidate[]>;
}

/**
 * The one hash the domain computes for itself.
 *
 * Content hashing belongs to `ContentStore` (§16.2) and stays there — this is for the
 * derived indexes, which have to answer "is the entry I hold built from the text I would
 * build now" about text that exists nowhere as a stored object: an FTS document and an
 * embedding input are both compositions of a title, an excerpt and a body window, assembled
 * on the way to a model or an index and never stored.
 *
 * It lives beside the other text utilities rather than in `identity/`, where it started,
 * because a token digest and an index digest have nothing in common but the algorithm.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

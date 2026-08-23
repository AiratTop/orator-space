import type { ArticleLink, ThreadComment } from "../ports/reading.js";
import { renderMarkdown } from "./render.js";

/**
 * Preparing a conversation for display (SPEC §76, §57.1).
 *
 * Here rather than in the web app because two of the three things below are security
 * decisions rather than layout: a comment body is untrusted markdown written by a
 * participant, and an edge's target is a string a participant chose. A page that did its
 * own rendering would be a second place for either to be got wrong, and the second place is
 * always the one nobody audits.
 */

export interface CommentNode {
  comment: ThreadComment;
  /** Sanitised HTML, or null when the body was withheld (§23.2) or failed to render. */
  html: string | null;
  children: CommentNode[];
}

/**
 * One untrusted body, rendered (SPEC §57.1).
 *
 * Extracted from `threadOf` so the profile's comments tab reaches the same function rather
 * than reaching for `renderMarkdown` on its own. That is the whole reason this module is in
 * the domain: a second rendering path for participant-written markdown is a second place
 * for an escape to hide, and the second place is always the one nobody audits.
 */
export function renderCommentBody(body: string | null, options: { siteHost: string }): string | null {
  if (body === null) return null;
  const result = renderMarkdown(body, { siteHost: options.siteHost });
  return result.ok ? result.html : null;
}

/**
 * The flat thread becomes a tree.
 *
 * Rows arrive in creation order (§12.2), so a parent is always seen before its replies and
 * one pass is enough. A reply whose parent is not on this page — the thread was truncated —
 * is promoted to the top level rather than dropped: a comment at the wrong indent is a
 * smaller lie than a comment that is missing.
 */
export function threadOf(
  comments: readonly ThreadComment[],
  options: { siteHost: string },
): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  const roots: CommentNode[] = [];

  for (const comment of comments) {
    /*
     * A comment goes through exactly the sanitiser an article body does. Not a lighter one:
     * a comment is the cheaper thing to post, so it is the likelier vector, and a second
     * rendering path would be a second place for an escape to hide.
     */
    const node: CommentNode = {
      comment,
      html: renderCommentBody(comment.body, options),
      children: [],
    };
    byId.set(comment.id, node);

    const parent = comment.parentCommentId === null ? undefined : byId.get(comment.parentCommentId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  return roots;
}

/**
 * Where an edge points, when it points somewhere a reader may safely follow.
 *
 * `dst_uri` is a string a participant supplied. It is validated as a URL on the way in, and
 * `javascript:` is a URL — so the scheme is checked here, at the point where the value
 * becomes an `href`, which is the only place the check does any good. §57.1.4 makes the
 * same rule for links inside markdown; this is that rule applied outside it.
 *
 * Null means "render this as text, not as a link", which is also the answer for an edge
 * whose target is a draft, a removed article, or an article by a suspended principal.
 */
export function safeLinkHref(link: ArticleLink): string | null {
  if (link.article !== null) {
    return `/p/${link.article.id}`;
  }
  if (link.uri === null) return null;
  try {
    const url = new URL(link.uri);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/*
 * The back-to-top link's manners (SPEC §49.1 as ADR 0018 rewrote it, §57.2).
 *
 * The control is a real link to `#top` and following it works with scripting off — this file
 * is not what makes it function. It fixes two things a plain fragment link cannot:
 *
 *   the address bar   a fragment navigation appends `#top` to the URL, so a reader who
 *                     pressed the button once carries it into every link they copy afterwards
 *   focus             `preventDefault` stops the browser moving focus, so this puts it back
 *                     on the masthead — a keyboard reader who presses "top" should arrive at
 *                     the top, not stay where they were with the page scrolled away
 *
 * §49.1 admits an action that begins and ends on the reader's own device. Scrolling is that:
 * no network, nothing rendered that the page did not already say, and the page is fully
 * functional without it.
 */
(function () {
  var button = document.querySelector("[data-to-top]");
  if (!button) return;

  button.addEventListener("click", function (event) {
    // A modified click is somebody asking for a new tab or a saved link. Leave it alone.
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();

    /*
     * `scroll-behavior: smooth` is on `html` and the reduced-motion block turns it off — but
     * an explicit `behavior` here would override both, so the preference is read rather than
     * assumed. A reader who asked for less motion asked for it from every direction.
     */
    var still = false;
    try {
      still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      // No `matchMedia` is not a reason to fail to scroll.
    }

    scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });

    // `preventScroll`, because focusing an element normally scrolls it into view — which
    // would jump to the top instantly and undo the animation that is still running.
    var top = document.getElementById("top");
    if (top && top.focus) top.focus({ preventScroll: true });
  });
})();

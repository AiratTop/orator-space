/*
 * Copy this article's address (SPEC §49.1 as ADR 0018 rewrote it, §57.2).
 *
 * §49.1 admits a script only for something belonging to the reader's own device that the
 * server cannot do, and it names three properties that all have to hold. This meets them:
 *
 *   the page works without it   the address was never anywhere but the address bar
 *   hidden until it works       the button carries `hidden` in the markup and this removes it
 *   no network, no content      `navigator.clipboard` and nothing else is touched
 *
 * A file rather than an inline script, because `script-src 'self'` carries no `unsafe-inline`
 * and no nonce. Loaded by the article page alone.
 */
(function () {
  var DONE = "Copied";
  var HOLD = 1600;

  var buttons = document.querySelectorAll("[data-copy-url]");
  if (buttons.length === 0) return;

  // `navigator.clipboard` is absent over plain HTTP other than localhost, and absent in a
  // few embedded browsers. Leaving the button hidden is the honest outcome: it would be a
  // control that throws rather than one that works.
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;

  for (var i = 0; i < buttons.length; i++) attach(buttons[i]);

  function attach(button) {
    var label = button.querySelector("[data-copy-url-label]");
    var original = label ? label.textContent : "";
    var timer = null;

    button.hidden = false;

    button.addEventListener("click", function () {
      /*
       * The canonical address, not `location.href`.
       *
       * A reader can arrive at this page carrying anything in the query string — a comment
       * outcome from a redirect, somebody's campaign parameters — and copying that would
       * hand the next reader a link to this reader's last action. `<link rel="canonical">`
       * is on every page (§50.1) and is the address this article actually has.
       */
      var canonical = document.querySelector('link[rel="canonical"]');
      var url = canonical ? canonical.href : location.origin + location.pathname;

      navigator.clipboard.writeText(url).then(
        function () {
          if (!label) return;
          label.textContent = DONE;
          // `aria-live` on the label would announce every keystroke of the timer; the state
          // is on the button instead, where a screen reader reads it with the control.
          button.setAttribute("data-copied", "");
          clearTimeout(timer);
          timer = setTimeout(function () {
            label.textContent = original;
            button.removeAttribute("data-copied");
          }, HOLD);
        },
        function () {
          // Denied by permission policy, or the document is not focused. Say nothing and
          // leave the button alone: the reader still has the address bar.
        },
      );
    });
  }
})();

/*
 * The theme switch (SPEC §49.1, §57.2).
 *
 * A file rather than an inline script, because `script-src 'self'` admits no inline script
 * and relaxing it for a colour preference would be the wrong trade by some distance. It is
 * loaded synchronously in the head: the whole job is to set the attribute before the first
 * paint, and a deferred version would show the wrong theme and then correct itself.
 *
 * Three states. "System" is the absence of a stored choice, not a third value written down,
 * so a reader who never touches this follows their operating system for ever — and one who
 * chose "system" explicitly is in exactly the same state as one who never chose at all.
 */
(function () {
  var KEY = "orator-theme";
  var root = document.documentElement;

  function stored() {
    // Private browsing, blocked storage, and a browser with cookies off all throw here
    // rather than returning null. None of them is a reason to fail to render a page.
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  function apply(choice) {
    if (choice === "dark" || choice === "light") root.setAttribute("data-theme", choice);
    else root.removeAttribute("data-theme");
  }

  apply(stored());

  function ready() {
    var control = document.querySelector("[data-theme-control]");
    if (!control) return;

    // Shown only now: without this script the buttons would do nothing, and a control that
    // does nothing is worse than no control.
    control.hidden = false;

    var buttons = control.querySelectorAll("button[data-theme]");
    function mark(choice) {
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-theme") === choice));
      }
    }

    var saved = stored();
    mark(saved === "dark" || saved === "light" ? saved : "system");

    control.addEventListener("click", function (event) {
      var button = event.target.closest && event.target.closest("button[data-theme]");
      if (!button) return;

      var choice = button.getAttribute("data-theme");
      try {
        if (choice === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch {
        // The choice still applies to this page; it simply will not outlive it.
      }
      apply(choice);
      mark(choice);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();

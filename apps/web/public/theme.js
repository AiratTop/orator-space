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
 *
 * Two controls now: the named three in the footer, which say what the states are, and one
 * icon in the masthead that cycles between them for the reader who is already squinting at a
 * white page. They share one `setChoice`, so pressing either updates both — two controls that
 * each kept their own idea of the current state would disagree on the first click.
 */
(function () {
  var KEY = "orator-theme";
  var ORDER = ["light", "dark", "system"];
  var LABEL = {
    light: "Theme: light. Switch to dark.",
    dark: "Theme: dark. Switch to system.",
    system: "Theme: follows your system. Switch to light.",
  };
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

  function normalise(choice) {
    return choice === "dark" || choice === "light" ? choice : "system";
  }

  function apply(choice) {
    if (choice === "dark" || choice === "light") root.setAttribute("data-theme", choice);
    else root.removeAttribute("data-theme");
  }

  apply(stored());

  function ready() {
    var panels = document.querySelectorAll("[data-theme-control]");
    var cycles = document.querySelectorAll("[data-theme-cycle]");
    if (panels.length === 0 && cycles.length === 0) return;

    // Shown only now: without this script the controls would do nothing, and a control that
    // does nothing is worse than no control.
    for (var p = 0; p < panels.length; p++) panels[p].hidden = false;
    for (var c = 0; c < cycles.length; c++) cycles[c].hidden = false;

    function mark(choice) {
      for (var i = 0; i < panels.length; i++) {
        var buttons = panels[i].querySelectorAll("button[data-theme]");
        for (var j = 0; j < buttons.length; j++) {
          buttons[j].setAttribute("aria-pressed", String(buttons[j].getAttribute("data-theme") === choice));
        }
      }
      for (var k = 0; k < cycles.length; k++) {
        // The icon is chosen in CSS from this attribute, so the button has one source of
        // truth rather than a class list that has to be added and removed in step.
        cycles[k].setAttribute("data-choice", choice);
        cycles[k].setAttribute("aria-label", LABEL[choice]);
        var label = cycles[k].querySelector("[data-theme-cycle-label]");
        if (label) label.textContent = LABEL[choice];
      }
    }

    function setChoice(choice) {
      try {
        if (choice === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch {
        // The choice still applies to this page; it simply will not outlive it.
      }
      apply(choice);
      mark(choice);
    }

    mark(normalise(stored()));

    for (var a = 0; a < panels.length; a++) {
      panels[a].addEventListener("click", function (event) {
        var button = event.target.closest && event.target.closest("button[data-theme]");
        if (!button) return;
        setChoice(button.getAttribute("data-theme"));
      });
    }

    for (var b = 0; b < cycles.length; b++) {
      cycles[b].addEventListener("click", function () {
        var current = normalise(stored());
        setChoice(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]);
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();

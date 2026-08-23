/*
 * The account page's one script (SPEC §49.1, §57.2).
 *
 * One job: copying a token that is shown exactly once (§42.2). Everything else on the page
 * is a form or a `<details>`, and the scope preset that changes what is listed beneath it is
 * CSS — a radio and `:has()`, so it works before this file arrives and if it never does.
 *
 * A separate file rather than an inline handler because `script-src 'self'` has no
 * `unsafe-inline` (§57.2), which is affordable precisely because pages like this one do
 * almost nothing.
 */
const button = document.getElementById("copy-token");
const value = document.getElementById("token-value");

if (button !== null && value !== null) {
  const original = button.textContent;
  let restore = 0;

  const say = (text) => {
    button.textContent = text;
    if (restore !== 0) window.clearTimeout(restore);
    restore = window.setTimeout(() => {
      button.textContent = original;
    }, 2500);
  };

  /**
   * Selecting the token, for when the clipboard is refused.
   *
   * Clipboard access is not always granted — an insecure context, a permissions policy, a
   * browser that asks first. Leaving somebody in front of 26 characters of base32 with no
   * feedback is the failure worth avoiding, so the fallback puts them one keystroke away
   * instead of at a dead end.
   */
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(value);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value.textContent ?? "");
      say("Copied");
    } catch {
      select();
      say("Selected — press ⌘C");
    }
  };

  button.addEventListener("click", copy);

  /*
   * The token itself copies too.
   *
   * It is the largest thing on the block and the thing somebody is looking at, so it is
   * what they click. `user-select: all` already made one click select the whole value, which
   * meant the click did something — just not the thing they wanted.
   *
   * Keyboard-reachable as well: a `tabindex` and a `role` on the element make it a control
   * rather than a piece of text that happens to respond to a mouse.
   */
  value.addEventListener("click", copy);
  value.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void copy();
    }
  });
}

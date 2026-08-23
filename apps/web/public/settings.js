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

  button.addEventListener("click", async () => {
    const token = value.textContent ?? "";
    try {
      await navigator.clipboard.writeText(token);
      button.textContent = "Copied";
    } catch {
      /*
       * Clipboard access can be refused — an insecure context, a permissions policy, a
       * browser that asks. Selecting the text is the fallback that always works, and it
       * leaves the person one keystroke from the same result rather than at a dead end.
       */
      const range = document.createRange();
      range.selectNodeContents(value);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      button.textContent = "Selected — press ⌘C";
    }
    setTimeout(() => {
      button.textContent = original;
    }, 2500);
  });
}

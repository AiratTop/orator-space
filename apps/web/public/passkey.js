/*
 * Sign-in, in the browser (SPEC §42.2, §49.1).
 *
 * An external file rather than an inline script, because the content security policy is
 * `script-src 'self'` with no `unsafe-inline` (§57.2) and that policy is worth more than
 * the convenience of putting eight lines in a page.
 *
 * One of two scripts on the site — the other sets the colour theme — and §49.1 draws the
 * line they both sit on: a script may carry something the server cannot know about the
 * reader's own device, and nothing else. A passkey ceremony is that by construction, since
 * the private half never leaves the device. Everything the site *says* is rendered on the
 * server, and a reader with scripts off loses the theme control and the sign-in button.
 */
const b64urlToBytes = (value) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

const bytesToB64url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const post = async (path, body) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(parsed?.detail ?? parsed?.title ?? "Something went wrong");
  return parsed;
};

/** The shape `navigator.credentials` returns, flattened to what the server expects. */
const serialise = (credential) => ({
  id: credential.id,
  rawId: bytesToB64url(credential.rawId),
  type: credential.type,
  clientExtensionResults: credential.getClientExtensionResults(),
  authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  response: Object.fromEntries(
    Object.entries({
      clientDataJSON: credential.response.clientDataJSON,
      attestationObject: credential.response.attestationObject,
      authenticatorData: credential.response.authenticatorData,
      signature: credential.response.signature,
      userHandle: credential.response.userHandle,
    })
      .filter(([, value]) => value instanceof ArrayBuffer)
      .map(([key, value]) => [key, bytesToB64url(value)]),
  ),
});

function say(message, isError) {
  const status = document.getElementById("status");
  if (status === null) return;
  status.textContent = message;
  status.className = isError ? "notice" : "";
}

async function signIn() {
  say("Waiting for your passkey…", false);
  try {
    const options = await post("/auth/passkey/login-options");
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBytes(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
        allowCredentials: (options.allowCredentials ?? []).map((entry) => ({
          id: b64urlToBytes(entry.id),
          type: "public-key",
        })),
      },
    });
    if (credential === null) throw new Error("No passkey was chosen");

    const result = await post("/auth/passkey/login", serialise(credential));
    say(`Signed in as @${result.username}. Redirecting…`, false);
    window.location.href = `/@${result.username}`;
  } catch (error) {
    say(error instanceof Error ? error.message : "Could not sign in", true);
  }
}

async function addPasskey() {
  say("Waiting for your device…", false);
  try {
    const options = await post("/auth/passkey/register-options");
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBytes(options.challenge),
        rp: options.rp,
        user: {
          id: b64urlToBytes(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        attestation: options.attestation,
        authenticatorSelection: options.authenticatorSelection,
        excludeCredentials: (options.excludeCredentials ?? []).map((entry) => ({
          id: b64urlToBytes(entry.id),
          type: "public-key",
        })),
      },
    });
    if (credential === null) throw new Error("No passkey was created");

    await post("/auth/passkey/register", serialise(credential));
    say("Passkey added.", false);
  } catch (error) {
    say(error instanceof Error ? error.message : "Could not add a passkey", true);
  }
}

document.getElementById("signin")?.addEventListener("click", signIn);
document.getElementById("add-passkey")?.addEventListener("click", addPasskey);

if (window.PublicKeyCredential === undefined) {
  say("This browser does not support passkeys.", true);
  for (const id of ["signin", "add-passkey"]) {
    const button = document.getElementById(id);
    if (button !== null) button.disabled = true;
  }
}

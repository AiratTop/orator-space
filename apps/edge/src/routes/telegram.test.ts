import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.js";

/**
 * The webhook, through Hono and D1 (SPEC §9.3, §68).
 *
 * This file exists because it did not, and the absence was the shape §13.35 warns about: the
 * service underneath is well covered and correct, and the login link was still broken in
 * production the whole time those tests passed. What only shows up here is the half the
 * service cannot see — the secret-token check, which §9.3 calls "the whole of the security of
 * this feature", the surface the route is answerable on, and the parsing that turns a
 * Telegram update into a command.
 *
 * The Bot API is replaced by a controlled sender rather than mocked away: what the bot says
 * is the whole of its interface, and half of these assertions are about the sentence that
 * arrives in the chat.
 */

const API = "https://api-staging.orator.space";
const SECRET = "webhook-secret-value";

/** The bindings a deployment with a bot has; `env` alone is one that has none. */
const bot: typeof env = { ...env, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_WEBHOOK_SECRET: SECRET };

interface Said {
  chatId: string;
  text: string;
}

/** What the bot tried to say, in order, and what Telegram answered. */
let said: Said[] = [];

/**
 * Stands in for the Bot API.
 *
 * Every message gets a `message_id`, because the route records one for a login link and a
 * sender that never returns one would leave that path untested.
 */
function sender(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.telegram.org/")) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string; text?: string };
    said.push({ chatId: String(body.chat_id ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ ok: true, result: { message_id: said.length } }), {
      headers: { "content-type": "application/json" },
    });
  });
}

const update = (text: string, from = "42", chat = "99"): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
  body: JSON.stringify({
    message: { text, chat: { id: Number(chat) }, from: { id: Number(from), username: "reader" } },
  }),
});

const post = (init: RequestInit, bindings: typeof env = bot) =>
  app.request(`${API}/telegram/webhook`, init, bindings);

/** A principal to bind chats to. The site issues nonces; this Worker only redeems them. */
let principalId: string;

const issueNonce = async (owner: string, nonce: string, expiresInMs = 10 * 60 * 1000) => {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO telegram_links (nonce, principal_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(nonce, owner, new Date(now).toISOString(), new Date(now + expiresInMs).toISOString())
    .run();
};

/** SPEC §62 — the rows the operations left behind, oldest first. */
const auditRows = async () => {
  const { results } = await env.DB.prepare(
    `SELECT action, actor_principal_id, outcome, reason, ip_hash, request_id, target_type
       FROM audit_log WHERE action LIKE 'telegram.%' ORDER BY id`,
  ).all<{
    action: string;
    actor_principal_id: string | null;
    outcome: string;
    reason: string | null;
    ip_hash: string | null;
    request_id: string;
    target_type: string | null;
  }>();
  return results;
};

const accountRow = (telegramUserId: string) =>
  env.DB.prepare(`SELECT * FROM telegram_accounts WHERE telegram_user_id = ?`)
    .bind(telegramUserId)
    .first<{ principal_id: string; chat_id: string; username: string | null }>();

beforeAll(async () => {
  const registered = await app.request(
    `${API}/v1/humans`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "chatowner" }),
    },
    env,
  );
  principalId = ((await registered.json()) as { id: string }).id;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  said = [];
  await env.DB.prepare(`DELETE FROM telegram_accounts`).run();
  await env.DB.prepare(`DELETE FROM telegram_links`).run();
  await env.DB.prepare(`DELETE FROM telegram_logins`).run();
  await env.DB.prepare(`DELETE FROM audit_log WHERE action LIKE 'telegram.%'`).run();
});

describe("the secret token (SPEC §9.3)", () => {
  /**
   * The endpoint is public by necessity and an update is a statement about who somebody is.
   * Without this check, anybody who finds the address can present any Telegram identity —
   * which is a way to bind their chat to somebody else's account.
   */
  it("refuses an update presenting the wrong secret, without reading the body", async () => {
    sender();
    await issueNonce(principalId, "NONCE0001");
    const response = await post({
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
      body: JSON.stringify({ message: { text: "/start NONCE0001", chat: { id: 99 }, from: { id: 42 } } }),
    });

    expect(response.status).toBe(401);
    expect(said).toHaveLength(0);
    expect(await accountRow("42")).toBeNull();
  });

  it("refuses one presenting no secret at all", async () => {
    sender();
    const response = await post({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { text: "/help", chat: { id: 99 }, from: { id: 42 } } }),
    });

    expect(response.status).toBe(401);
    expect(said).toHaveLength(0);
  });

  it("says nothing about why it refused", async () => {
    // Not a problem document: this is not an API for anybody to call, and an error that
    // explains itself helps somebody guess.
    sender();
    const response = await post({
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": `${SECRET}-longer` },
      body: "{}",
    });
    expect(await response.text()).toBe("");
  });

  it("answers 404 on a deployment with no bot configured", async () => {
    // One bundle serves every environment (§9.3, one bot per deployment). A Worker with no
    // token has no bot, and "there is nothing at this address" is the true answer.
    sender();
    const response = await post(update("/help"), env);
    expect(response.status).toBe(404);
  });
});

describe("the surface it answers on (SPEC §57.4, §63)", () => {
  it("is not reachable on the media host", async () => {
    sender();
    const response = await app.request(
      "https://media-staging.orator.space/telegram/webhook",
      update("/help"),
      bot,
    );
    expect(response.status).toBe(404);
  });

  it("is not reachable on the MCP host", async () => {
    sender();
    const response = await app.request(
      "https://mcp-staging.orator.space/telegram/webhook",
      update("/help"),
      bot,
    );
    expect(response.status).toBe(404);
  });
});

describe("linking a chat (SPEC §9.3)", () => {
  it("binds the chat the nonce was pressed from, and says so", async () => {
    sender();
    await issueNonce(principalId, "NONCE0002");
    const response = await post(update("/start NONCE0002"));

    expect(response.status).toBe(200);
    const account = await accountRow("42");
    expect(account?.principal_id).toBe(principalId);
    expect(account?.chat_id).toBe("99");
    expect(account?.username).toBe("reader");

    // Two messages: what just happened, then what the bot can do.
    expect(said).toHaveLength(2);
    expect(said[0]?.text).toContain("Connected.");
    expect(said[0]?.text).toContain("/settings?tab=telegram");
    expect(said[1]?.text).toContain("/login");
  });

  it("works once: the same nonce a second time is refused", async () => {
    sender();
    await issueNonce(principalId, "NONCE0003");
    await post(update("/start NONCE0003"));
    said = [];

    await post(update("/start NONCE0003", "43", "100"));
    expect(said[0]?.text).toContain("no longer usable");
    // The second chat got nothing: one nonce, one binding.
    expect(await accountRow("43")).toBeNull();
  });

  it("refuses an expired one, and says the same thing", async () => {
    sender();
    await issueNonce(principalId, "NONCE0004", -1000);
    await post(update("/start NONCE0004"));

    expect(said[0]?.text).toContain("no longer usable");
    expect(await accountRow("42")).toBeNull();
  });

  it("refuses a nonce that never existed", async () => {
    sender();
    await post(update("/start NEVEREXISTED"));
    expect(said[0]?.text).toContain("no longer usable");
    expect(await accountRow("42")).toBeNull();
  });

  it("tells a Telegram account already bound elsewhere to disconnect there first", async () => {
    sender();
    const second = await app.request(
      `${API}/v1/humans`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "otherowner" }),
      },
      env,
    );
    const otherId = ((await second.json()) as { id: string }).id;

    await issueNonce(principalId, "NONCE0005");
    await post(update("/start NONCE0005"));
    said = [];

    await issueNonce(otherId, "NONCE0006");
    await post(update("/start NONCE0006"));

    expect(said[0]?.text).toContain("already connected to another");
    expect((await accountRow("42"))?.principal_id).toBe(principalId);
  });

  it("greets a bare /start, which is somebody who found the bot on their own", async () => {
    sender();
    await post(update("/start"));
    expect(said[0]?.text).toContain("Connect this chat to your account");
  });

  it("accepts the command addressed to the bot by name", async () => {
    // Telegram appends `@botname` in groups, and a person copying a command carries it.
    sender();
    await issueNonce(principalId, "NONCE0007");
    await post(update("/start@orator_space_bot NONCE0007"));
    expect((await accountRow("42"))?.principal_id).toBe(principalId);
  });
});

describe("what the chat can ask (SPEC §9.3)", () => {
  const link = async (nonce = "NONCE0100") => {
    await issueNonce(principalId, nonce);
    await post(update(`/start ${nonce}`));
    said = [];
  };

  it("/status names the account, linked, and without an @ Telegram would mistake for a mention", async () => {
    sender();
    await link();
    await post(update("/status"));

    expect(said[0]?.text).toContain("chatowner</a>");
    expect(said[0]?.text).toContain("/@chatowner");
    expect(said[0]?.text).not.toContain("@chatowner<");
  });

  it("/status on an unconnected chat says where to connect one", async () => {
    sender();
    await post(update("/status"));
    expect(said[0]?.text).toContain("not connected to any Orator.Space account");
  });

  it("/help works whether or not the chat is connected", async () => {
    sender();
    await post(update("/help"));
    expect(said[0]?.text).toContain("/login");
    expect(said[0]?.text).toContain("/status");
  });

  it("answers anything it does not understand rather than staying silent", async () => {
    sender();
    await post(update("hello?"));
    expect(said[0]?.text).toContain("Orator.Space");
  });

  it("acknowledges an update with no chat or sender without acting on it", async () => {
    sender();
    const response = await post({
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify({ edited_message: { text: "/help" } }),
    });

    // 200, or Telegram redelivers it forever.
    expect(response.status).toBe(200);
    expect(said).toHaveLength(0);
  });

  it("acknowledges a body that is not JSON", async () => {
    sender();
    const response = await post({
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: "not json at all",
    });
    expect(response.status).toBe(200);
    expect(said).toHaveLength(0);
  });
});

describe("a sign-in link (SPEC §9.3, §9.1)", () => {
  const link = async (nonce = "NONCE0200") => {
    await issueNonce(principalId, nonce);
    await post(update(`/start ${nonce}`));
    said = [];
  };

  it("issues one into a connected chat, and records the message it was sent in", async () => {
    sender();
    await link();
    await post(update("/login"));

    const login = await env.DB.prepare(
      `SELECT nonce, principal_id, chat_id, used_at, message_id FROM telegram_logins`,
    ).first<{ nonce: string; principal_id: string; chat_id: string; used_at: string | null; message_id: string | null }>();

    expect(login?.principal_id).toBe(principalId);
    expect(login?.chat_id).toBe("99");
    expect(login?.used_at).toBeNull();
    // Recorded so the spent link can be taken back out of the chat (§9.3).
    expect(login?.message_id).not.toBeNull();
    expect(said[0]?.text).toContain(`/auth/telegram?token=${login?.nonce}`);
    expect(said[0]?.text).toContain("works once");
  });

  it("refuses one to a chat that is not connected, and creates no nonce", async () => {
    sender();
    await post(update("/login"));

    expect(said[0]?.text).toContain("not connected");
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM telegram_logins`).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("asks Telegram not to preview the link it just sent", async () => {
    // A one-time credential fetched by a preview crawler is a credential spent before the
    // person sees it. The site no longer treats a fetch as use, so this is the second lock.
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    });

    await issueNonce(principalId, "NONCE0201");
    await post(update("/start NONCE0201"));
    await post(update("/login"));

    expect(bodies.at(-1)).toContain('"link_preview_options":{"is_disabled":true}');
  });
});

describe("disconnecting from the chat (SPEC §9.3, §23.5)", () => {
  const link = async (nonce = "NONCE0300") => {
    await issueNonce(principalId, nonce);
    await post(update(`/start ${nonce}`));
    said = [];
  };

  it("asks first, and removes nothing", async () => {
    sender();
    await link();
    await post(update("/disconnect"));

    expect(said[0]?.text).toContain("/disconnect_confirm");
    expect(await accountRow("42")).not.toBeNull();
  });

  it("removes the binding once confirmed", async () => {
    sender();
    await link();
    await post(update("/disconnect_confirm"));

    expect(said[0]?.text).toContain("Disconnected.");
    expect(await accountRow("42")).toBeNull();
  });

  it("tells an unconnected chat there is nothing to disconnect", async () => {
    sender();
    await post(update("/disconnect"));
    expect(said[0]?.text).toContain("not connected");
  });
});

describe("what reaches the audit log (SPEC §62, §42.2)", () => {
  /**
   * A bound chat is a credential — it receives notifications and can ask for a link that
   * opens a session — and none of these operations wrote a row until §13.37 counted them.
   * The Worker's log is not a substitute: it is kept for days and cannot be queried by
   * principal, which is the one question an account holder asks afterwards.
   */
  it("records the binding against the principal whose nonce it was", async () => {
    sender();
    await issueNonce(principalId, "NONCE0400");
    await post(update("/start NONCE0400"));

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "telegram.linked",
      actor_principal_id: principalId,
      outcome: "success",
      target_type: "telegram",
    });
  });

  it("stores no address for an update, because the address is Telegram's", async () => {
    // The caller here is a data centre, not the person. A pseudonym of it would put one
    // operator's infrastructure in the column that exists to identify a caller.
    sender();
    await issueNonce(principalId, "NONCE0401");
    await post(update("/start NONCE0401"));

    expect((await auditRows())[0]?.ip_hash).toBeNull();
    expect((await auditRows())[0]?.request_id).not.toBe("");
  });

  it("records a refused nonce without naming anybody", async () => {
    sender();
    await post(update("/start NEVEREXISTED"));

    expect((await auditRows())[0]).toMatchObject({
      action: "telegram.linked",
      actor_principal_id: null,
      outcome: "denied",
      reason: "unknown-nonce",
    });
  });

  it("records the sign-in link the chat asked for", async () => {
    sender();
    await issueNonce(principalId, "NONCE0402");
    await post(update("/start NONCE0402"));
    await post(update("/login"));

    expect((await auditRows()).map((row) => row.action)).toEqual([
      "telegram.linked",
      "telegram.login.issued",
    ]);
  });

  it("records /login from an unconnected chat as a denial", async () => {
    sender();
    await post(update("/login"));

    expect((await auditRows())[0]).toMatchObject({
      action: "telegram.login.issued",
      actor_principal_id: null,
      outcome: "denied",
      reason: "chat-not-connected",
    });
  });

  it("says a disconnection came from the chat, which is not the same act as the page", async () => {
    sender();
    await issueNonce(principalId, "NONCE0403");
    await post(update("/start NONCE0403"));
    await post(update("/disconnect_confirm"));

    expect((await auditRows()).at(-1)).toMatchObject({
      action: "telegram.unlinked",
      actor_principal_id: principalId,
      outcome: "success",
      reason: "from=chat",
    });
  });

  it("writes nothing for a command that changes nothing", async () => {
    // `/help` and `/status` are reads. A row for each would be a log of somebody using a
    // bot, in the table that exists for credential operations.
    sender();
    await post(update("/help"));
    await post(update("/status"));
    expect(await auditRows()).toHaveLength(0);
  });
});

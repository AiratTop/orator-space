import { beforeEach, describe, expect, it } from "vitest";
import { ErrorType } from "@orator/protocol";
import { createMemoryPorts } from "../testing/memory-repos.js";
import { AGENT_PRESET, OWNER_PRESET } from "../identity/scopes.js";
import type { Actor } from "../identity/authz.js";
import type { RequestContext } from "./context.js";
import { createArticle, publishArticle } from "./publishing.js";
import { applyClosureDisposition, closeAccount } from "./closure.js";

/**
 * SPEC §23.5 — closing an account is a distinct operation, not a matter of deleting articles.
 *
 * The two questions are separable and the tests below keep them separate, because getting
 * them confused is the failure: an implementation that deletes the writing closes more than
 * was asked, and one that only marks a status closes less. What has to be true immediately
 * is that no credential still works; what happens to the writing is a choice, applied after.
 */

let ports: ReturnType<typeof createMemoryPorts>;

const HUMAN = "OWNER-H";
const AGENT = "AGENT-A";
const OTHER = "OTHER-H";

const human = (id = HUMAN, role: "user" | "admin" = "user"): Actor => ({
  principalId: id,
  kind: "human",
  platformRole: role,
  scopes: OWNER_PRESET,
  status: "active",
  trustLevel: 1,
  systemAccount: false,
});

const agentActor = (): Actor => ({
  principalId: AGENT,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: HUMAN,
  status: "active",
  trustLevel: 1,
  systemAccount: false,
});

const ctxFor = (who: Actor | null): RequestContext => ({
  ports,
  requestId: "REQ",
  actor: who,
  tokenId: null,
  ipHash: null,
  userAgent: null,
  audience: "agent_api",
});

const principal = (id: string, username: string, extra: Record<string, unknown> = {}) => ({
  id: id as never,
  kind: "human" as const,
  username,
  usernameSkeleton: username,
  displayName: null,
  bio: null,
  status: "active" as const,
  platformRole: "user" as const,
  systemAccount: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const errorOf = (r: { ok: boolean; error?: { type: string } }): string | null =>
  r.ok ? null : (r.error?.type ?? "unknown");

const close = (actor: Actor | null, id = HUMAN, articles: "pseudonymise" | "unpublish" | "erase" = "pseudonymise") =>
  closeAccount(ctxFor(actor), id, { confirm: "close", articles });

beforeEach(async () => {
  ports = createMemoryPorts();
  ports.state.principals.set(HUMAN, principal(HUMAN, "owner"));
  ports.state.principals.set(OTHER, principal(OTHER, "somebody-else"));
  ports.state.principals.set(
    AGENT,
    principal(AGENT, "researcher", { kind: "agent", ownerPrincipalId: HUMAN, trustLevel: 1 }),
  );

  await ports.db.commit([
    ports.tokens.insert({
      id: "T-HUMAN" as never,
      principalId: HUMAN as never,
      name: "owner",
      tokenHash: "h1",
      prefix: "orat_sk_live_a",
      scopes: [...OWNER_PRESET],
      expiresAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    }),
    ports.tokens.insert({
      id: "T-AGENT" as never,
      principalId: AGENT as never,
      name: "agent",
      tokenHash: "h2",
      prefix: "orat_sk_live_b",
      scopes: [...AGENT_PRESET],
      expiresAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    }),
    ports.credentials.insert({
      id: "C1" as never,
      principalId: HUMAN as never,
      credentialId: "cred",
      publicKey: "pk",
      signCount: 0,
      transports: null,
      aaguid: null,
      label: null,
      backedUp: false,
      createdAt: "2026-08-01T00:00:00.000Z",
    }),
    ports.sessions.insert({
      id: "S1" as never,
      principalId: HUMAN as never,
      tokenHash: "s1",
      userAgent: null,
      ipHash: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2027-08-01T00:00:00.000Z",
      revokedAt: null,
    }),
    ports.principals.insertHumanAccount(HUMAN as never, "2026-08-01T00:00:00.000Z"),
    ports.telegram.upsertAccount({
      principalId: HUMAN as never,
      telegramUserId: "tg-1",
      chatId: "chat-1",
      username: "someone",
      linkedAt: "2026-08-01T00:00:00.000Z",
      unavailableSince: null,
    }),
  ]);
});

describe("who may close an account", () => {
  it("the holder", async () => {
    expect((await close(human())).ok).toBe(true);
  });

  it("an administrator", async () => {
    expect((await close(human(OTHER, "admin"))).ok).toBe(true);
  });

  it("not somebody else", async () => {
    expect(errorOf(await close(human(OTHER)))).toBe(ErrorType.Forbidden);
  });

  it("not an anonymous caller", async () => {
    expect(errorOf(await close(null))).toBe(ErrorType.Unauthenticated);
  });

  it("refuses an agent, which has no account to close", async () => {
    // §7.2 — an agent has no credentials its owner did not issue and no personal data,
    // because it is not a person. It is suspended as a consequence, not closed.
    expect(errorOf(await close(human(), AGENT))).toBe(ErrorType.ValidationFailed);
  });

  it("requires the confirmation verbatim", async () => {
    const refused = await closeAccount(ctxFor(human()), HUMAN, { confirm: "yes", articles: "pseudonymise" });
    expect(errorOf(refused)).toBe(ErrorType.ValidationFailed);
    expect(ports.state.principals.get(HUMAN)?.status).toBe("active");
  });
});

describe("what closing does immediately (§23.5)", () => {
  it("marks the principal deleted and keeps the username", async () => {
    const outcome = unwrap(await close(human()));

    expect(ports.state.principals.get(HUMAN)?.status).toBe("deleted");
    // §23.5 — immediate release lets somebody claim the name that articles were published
    // under and citations point at, and impersonate the previous author.
    expect(ports.state.principals.get(HUMAN)?.username).toBe("owner");
    expect(await ports.principals.findByUsername("owner")).not.toBeNull();
    expect(Date.parse(outcome.usernameReservedUntil)).toBeGreaterThan(ports.clock.now().getTime());
  });

  it("revokes every way in, including the agents' tokens", async () => {
    await close(human());

    // An agent's token was issued by this person and grants what this person granted;
    // leaving it live would leave the account acting after it was closed.
    expect(ports.state.tokens.get("T-HUMAN")?.revokedAt).not.toBeNull();
    expect(ports.state.tokens.get("T-AGENT")?.revokedAt).not.toBeNull();
    expect(ports.state.sessions[0]?.revokedAt).not.toBeNull();
    expect(ports.state.credentials).toHaveLength(0);
  });

  it("suspends the agents rather than deleting them", async () => {
    const outcome = unwrap(await close(human()));

    expect(outcome.agentsSuspended).toBe(1);
    // §23.5 — deleting one account would otherwise tear the citation graph for third
    // parties who cited what those agents published.
    expect(ports.state.principals.get(AGENT)?.status).toBe("suspended");
  });

  it("clears the personal data and keeps the row", async () => {
    // §23.5 — since ADR 0016 the account row holds one attribute of a person, and closure
    // clears it. A row with nothing left to clear would make this test vacuous, so it is
    // set first.
    ports.state.humanLocales.set(HUMAN, "ru");
    await close(human());
    expect(ports.state.humanLocales.get(HUMAN)).toBeNull();
    // The row is a foreign key target for articles, comments, edges and audit entries.
    expect(ports.state.principals.has(HUMAN)).toBe(true);
  });

  it("unlinks Telegram, and frees it to be connected again", async () => {
    await close(human());

    // §9.3 signs a person in through that chat, so a binding that survived the closure
    // would be a live way into a closed account.
    expect(await ports.telegram.findByPrincipal(HUMAN)).toBeNull();
    // And the other half: one Telegram account binds to one principal, so a row outliving
    // its account would refuse this person a new one for as long as it existed.
    expect(await ports.telegram.findByTelegramUser("tg-1")).toBeNull();
  });

  it("records the unlink as itself, not only as a closure", async () => {
    await close(human());
    // §62 — the other two unlink paths write `from=settings` and `from=chat`; a question
    // about when a chat stopped being bound has one answer whichever path did it.
    const entry = ports.state.audit.find((one) => one.action === "telegram.unlinked");
    expect(entry?.reason).toBe("from=closure");
  });

  it("records the closure in the audit log", async () => {
    await close(human());
    // §62 — the entry outlives the account and is pseudonymised on the §23.4 schedule.
    expect(ports.state.audit.some((entry) => entry.action === "account.closed")).toBe(true);
  });

  it("does not touch the articles in the request itself", async () => {
    const draft = unwrap(await createArticle(ctxFor(agentActor()), { title: "Measured", content: "# Measured\n\nA number.\n" }));
    unwrap(await publishArticle(ctxFor(agentActor()), draft.id));

    await close(human(), HUMAN, "erase");

    // Erasing one article is an R2 read, a refcount check and a delete (§23.3). "Let me
    // out" must not time out; the disposition travels on an event.
    expect(ports.state.articles.get(draft.id)?.status).toBe("published");
    expect(ports.state.outbox.some((entry) => entry.eventType === "principal.closed")).toBe(true);
  });
});

describe("what happens to the writing (§23.5 step 4)", () => {
  async function published(): Promise<string> {
    const draft = unwrap(
      await createArticle(ctxFor(agentActor()), { title: "Measured", content: "# Measured\n\nA number.\n" }),
    );
    unwrap(await publishArticle(ctxFor(agentActor()), draft.id));
    return draft.id;
  }

  it("keeps it, when the choice is a pseudonym", async () => {
    const id = await published();
    const result = await applyClosureDisposition(ports, HUMAN, "pseudonymise", [AGENT]);

    // The name an article carries is a username, and a username was never personal data —
    // it is the handle the work was published under and what citations point at (§7.3).
    expect(result.handled).toBe(0);
    expect(ports.state.articles.get(id)?.status).toBe("published");
  });

  it("unpublishes it, reversibly", async () => {
    const id = await published();
    await applyClosureDisposition(ports, HUMAN, "unpublish", [AGENT]);

    expect(ports.state.articles.get(id)?.status).toBe("unpublished");
    // §23.1 — unpublishing keeps the published pointer, so the decision is not final.
    expect(ports.state.articles.get(id)?.publishedRevisionId).not.toBeNull();
  });

  it("tombstones it, when the choice is erasure", async () => {
    const id = await published();
    await applyClosureDisposition(ports, HUMAN, "erase", [AGENT]);

    // §23.2 — the id keeps resolving so citations to it still answer with something that
    // says the article was removed.
    expect(ports.state.articles.get(id)?.status).toBe("removed");
  });

  it("tells the pipeline, so nothing stays in search or the sitemap", async () => {
    await published();
    await applyClosureDisposition(ports, HUMAN, "unpublish", [AGENT]);
    expect(ports.state.outbox.some((entry) => entry.eventType === "article.unpublished")).toBe(true);
  });

  it("is safe to run twice, because the queue delivers at least once", async () => {
    const id = await published();
    await applyClosureDisposition(ports, HUMAN, "erase", [AGENT]);
    const second = await applyClosureDisposition(ports, HUMAN, "erase", [AGENT]);

    expect(second.handled).toBe(0);
    expect(ports.state.articles.get(id)?.status).toBe("removed");
  });

  it("reports when a pass filled up, so the next one continues", async () => {
    for (let i = 0; i < 3; i += 1) {
      const draft = unwrap(
        await createArticle(ctxFor(agentActor()), { title: `A ${i}`, content: `# A ${i}\n\nA number.\n` }),
      );
      unwrap(await publishArticle(ctxFor(agentActor()), draft.id));
    }
    const first = await applyClosureDisposition(ports, HUMAN, "unpublish", [AGENT], 2);
    expect(first).toEqual({ handled: 2, moreToDo: true });
  });
});

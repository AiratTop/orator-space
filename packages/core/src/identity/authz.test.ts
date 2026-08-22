import { describe, expect, it } from "vitest";
import { canCreate, canManageAgent, canModerate, canModify, type Actor } from "./authz.js";
import { AGENT_PRESET } from "./scopes.js";

const owner: Actor = {
  principalId: "OWNER",
  kind: "human",
  platformRole: "user",
  scopes: [...AGENT_PRESET, "agents:manage"],
  status: "active",
  trustLevel: 1,
};

const agent = (id: string): Actor => ({
  principalId: id,
  kind: "agent",
  platformRole: "user",
  scopes: AGENT_PRESET,
  ownerPrincipalId: "OWNER",
  status: "active",
  trustLevel: 1,
});

const article = (authorId: string) => ({
  authorPrincipalId: authorId,
  authorOwnerPrincipalId: "OWNER",
});

const reasonOf = (d: ReturnType<typeof canModify>) => (d.allowed ? null : d.reason);

describe("resource authorisation (SPEC §43.2)", () => {
  it("lets an agent modify its own article", () => {
    expect(canModify(agent("A"), article("A"), "articles:write").allowed).toBe(true);
  });

  it("lets the accountable human modify an article its agent wrote", () => {
    expect(canModify(owner, article("A"), "articles:write").allowed).toBe(true);
  });

  it("refuses one agent acting on a sibling agent's article", () => {
    // Deliberate: it bounds the blast radius when a single agent is compromised.
    expect(reasonOf(canModify(agent("B"), article("A"), "articles:write"))).toBe("cross-agent");
  });

  it("refuses an unrelated principal", () => {
    const stranger: Actor = { ...agent("X"), ownerPrincipalId: "SOMEONE-ELSE" };
    expect(reasonOf(canModify(stranger, article("A"), "articles:write"))).toBe("not-owner");
  });

  it("requires the scope even from the resource owner", () => {
    const readOnly: Actor = { ...agent("A"), scopes: ["articles:read"] };
    expect(reasonOf(canModify(readOnly, article("A"), "articles:write"))).toBe("insufficient-scope");
  });

  it("separates writing from publishing", () => {
    const drafter: Actor = { ...agent("A"), scopes: ["articles:read", "articles:write"] };
    expect(canModify(drafter, article("A"), "articles:write").allowed).toBe(true);
    expect(reasonOf(canModify(drafter, article("A"), "articles:publish"))).toBe("insufficient-scope");
  });

  it("refuses a suspended principal before considering anything else", () => {
    const suspended: Actor = { ...agent("A"), status: "suspended" };
    expect(reasonOf(canModify(suspended, article("A"), "articles:write"))).toBe("suspended");
  });

  it("lets a moderator act, but only with the moderation scope", () => {
    const bare: Actor = { ...agent("M"), platformRole: "moderator", ownerPrincipalId: "OTHER" };
    expect(reasonOf(canModify(bare, article("A"), "articles:write"))).toBe("insufficient-scope");
    const scoped: Actor = { ...bare, scopes: [...AGENT_PRESET, "admin:moderate"] };
    expect(canModify(scoped, article("A"), "articles:write").allowed).toBe(true);
  });
});

describe("agent management (SPEC §43.2)", () => {
  it("lets the owner manage their agent", () => {
    expect(canManageAgent(owner, "OWNER").allowed).toBe(true);
  });

  it("refuses an agent managing itself — no self-escalation", () => {
    const self: Actor = { ...agent("A"), scopes: [...AGENT_PRESET, "agents:manage"] };
    expect(canManageAgent(self, "OWNER").allowed).toBe(false);
  });

  it("refuses a different human", () => {
    const other: Actor = { ...owner, principalId: "OTHER-HUMAN" };
    expect(canManageAgent(other, "OWNER").allowed).toBe(false);
  });
});

describe("creation and moderation", () => {
  it("gates creation on scope alone", () => {
    expect(canCreate(agent("A"), "articles:write").allowed).toBe(true);
    expect(canCreate({ ...agent("A"), scopes: [] }, "articles:write").allowed).toBe(false);
  });

  it("requires both role and scope to moderate", () => {
    expect(reasonOf(canModerate(agent("A")))).toBe("requires-moderator");
    const mod: Actor = { ...agent("A"), platformRole: "moderator" };
    expect(reasonOf(canModerate(mod))).toBe("insufficient-scope");
    expect(canModerate({ ...mod, scopes: ["admin:moderate"] }).allowed).toBe(true);
  });
});

import {
  endSession,
  issueToken,
  registerAgent,
  revokeToken,
  setAgentStatus,
  updateProfile,
  type AccountContext,
  type ServiceError,
} from "@orator/core";
import { AGENT_PRESET, DEFAULT_SCOPES, OWNER_PRESET } from "@orator/core";

/**
 * What a form on `/settings` may ask for (SPEC §49.2, §42.2).
 *
 * A closed set with one dispatcher, rather than a route per verb. Every one of these is a
 * browser form post that ends in the same place — the page re-rendered with the outcome on
 * it — and the same-origin check, the session lookup and the no-store headers are the same
 * three lines for all of them. Six routes would be six copies of those three lines, and the
 * copy that gets it wrong is the one nobody looks at again.
 */
export type ActionOutcome =
  | { kind: "none" }
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string; detail?: string }
  /** SPEC §42.2 — the one moment a token exists outside the response that made it. */
  | { kind: "token"; token: string; name: string; scopes: readonly string[] };

const problem = (error: ServiceError): ActionOutcome => ({
  kind: "failed",
  message: error.title,
  ...(error.detail === undefined ? {} : { detail: error.detail }),
});

/**
 * The scope presets a page offers, and nothing outside them.
 *
 * §42.2 wants tokens scoped, and a free-form scope field on a web form is a way to ask
 * somebody to type `articles:publish` correctly under time pressure. Each preset is named
 * for what it lets a caller do and the page lists what is in it, so the choice is
 * informed rather than merely constrained.
 */
export const PRESETS = {
  read: {
    label: "Read only",
    summary: "Can read articles and comments. Cannot write anything.",
    scopes: DEFAULT_SCOPES,
  },
  agent: {
    label: "Publish and take part",
    summary: "Everything an agent needs to publish, comment, cite and follow.",
    scopes: AGENT_PRESET,
  },
  owner: {
    label: "Everything this account can grant",
    summary: "The above, plus registering and managing agents. Give this out sparingly.",
    scopes: OWNER_PRESET,
  },
} as const;

/** The presets a form offers, in the order a person should consider them. */
export const AGENT_PRESETS = ["agent", "read"] as const;
export const OWN_PRESETS = ["read", "agent", "owner"] as const;

export type PresetName = keyof typeof PRESETS;
const isPreset = (value: string): value is PresetName => value in PRESETS;

const text = (form: FormData, field: string): string => {
  const value = form.get(field);
  return typeof value === "string" ? value.trim() : "";
};
const optional = (form: FormData, field: string): string | null => {
  const value = text(form, field);
  return value === "" ? null : value;
};

export async function performAction(ctx: AccountContext, form: FormData): Promise<ActionOutcome> {
  switch (text(form, "action")) {
    case "profile": {
      const result = await updateProfile(ctx, ctx.actor!.principalId, {
        displayName: optional(form, "display-name"),
        bio: optional(form, "bio"),
      });
      return result.ok ? { kind: "done", message: "Profile saved." } : problem(result.error);
    }

    case "agent.create": {
      const result = await registerAgent(ctx, {
        username: text(form, "username"),
        displayName: optional(form, "display-name"),
        model: optional(form, "model"),
        provider: optional(form, "provider"),
      });
      return result.ok
        ? { kind: "done", message: `@${result.value.username} registered. Issue it a token to put it to work.` }
        : problem(result.error);
    }

    case "agent.status": {
      const status = text(form, "status") === "suspended" ? "suspended" : "active";
      const result = await setAgentStatus(ctx, text(form, "agent"), status);
      return result.ok
        ? { kind: "done", message: status === "suspended" ? "Agent stopped. Its tokens still exist." : "Agent started." }
        : problem(result.error);
    }

    case "token.issue": {
      const preset = text(form, "preset");
      if (!isPreset(preset)) return { kind: "failed", message: "Unknown scope preset" };
      const name = text(form, "name");
      if (name === "") return { kind: "failed", message: "A token needs a name", detail: "It is the only way to tell one from another later." };

      const result = await issueToken(ctx, {
        principalId: text(form, "principal"),
        name,
        scopes: PRESETS[preset].scopes,
      });
      return result.ok
        ? { kind: "token", token: result.value.token, name, scopes: result.value.scopes }
        : problem(result.error);
    }

    case "token.revoke": {
      const result = await revokeToken(ctx, text(form, "token"));
      return result.ok ? { kind: "done", message: "Token revoked. Anything using it stops now." } : problem(result.error);
    }

    case "session.end": {
      const result = await endSession(ctx, text(form, "session"));
      return result.ok ? { kind: "done", message: "Session ended." } : problem(result.error);
    }

    default:
      return { kind: "failed", message: "Unknown action" };
  }
}

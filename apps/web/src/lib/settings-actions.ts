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


/**
 * The sections `/settings` is divided into (SPEC §49.2).
 *
 * One column of stacked panels stopped being navigable at the third, and two more were
 * coming. Tabs are the same server-rendered pattern the profile already uses, not a widget:
 * plain links, a query parameter, and no state anywhere but the URL.
 *
 * The review queue was here for a while and is not any more. It never belonged: a moderator
 * acting on somebody else's article is not doing account housekeeping, and putting the two
 * behind one address meant the platform's most consequential screen was reached through a
 * page about tokens and sessions. It lives at `/moderation` (§61.1), and `?tab=moderation`
 * redirects there so a bookmark still works.
 */
export const SETTINGS_TABS = ["agents", "saved", "tokens", "sessions", "profile"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const isSettingsTab = (value: string): value is SettingsTab =>
  (SETTINGS_TABS as readonly string[]).includes(value);

/**
 * Agents first, and it is not alphabetical.
 *
 * It is the reason the page exists: §7.2 makes a person accountable for every agent they
 * own, and this is where that accountability is exercised. Tokens follow because they are
 * what an agent needs to do anything; sessions and the profile are housekeeping.
 */
export const DEFAULT_TAB: SettingsTab = "agents";

export const SETTINGS_TAB_LABEL: Record<SettingsTab, string> = {
  agents: "Agents",
  saved: "Saved",
  tokens: "Tokens",
  sessions: "Sessions",
  profile: "Profile",
};

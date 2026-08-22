import type { Actor } from "../identity/authz.js";

/**
 * Who is asking (SPEC §66.5).
 *
 * §3.1 makes the product hypothesis entirely about machine interactions, and §66.5 draws
 * the conclusion: analytics that cannot separate a person from an agent can neither confirm
 * nor refute the thing this platform was built to test. Classical web analytics is built on
 * client-side JavaScript and therefore sees only `human_web` — for Orator, the least
 * interesting part of the traffic.
 *
 * **Classification comes from authentication and the entry point, never from a User-Agent.**
 * §66.5 is explicit and the reason is that a User-Agent is a string a client chooses. The
 * one class below that consults it is `crawler`, and it is deliberately the weakest claim
 * here: a hint about traffic that presented no credential at all, deciding nothing that
 * matters.
 */
export type AudienceClass =
  | "human_web"
  | "agent_api"
  | "agent_mcp"
  | "human_api"
  | "crawler"
  | "unknown";

/** Where the request arrived, which the Worker knows and a client cannot claim. */
export type Surface = "web" | "api" | "mcp" | "media";

/**
 * A crawler, as far as a User-Agent can say (§66.5).
 *
 * Only consulted for traffic that authenticated as nobody. A crawler forging this to look
 * like a browser would be counted as `unknown` rather than `human_web`, because a browser
 * is identified here by asking for HTML, not by its name.
 *
 * The word boundary is on the right only, which is not a slip: every crawler that matters
 * writes the word inside a longer one — `Googlebot`, `Bingbot`, `ClaudeBot`, `GPTBot` — so
 * requiring a boundary on the left matches none of them. The cost is that "robot" matches
 * too, and since nothing is decided by this class, that cost is nothing.
 */
const CRAWLER = /(bot|crawler|spider|slurp|bingpreview|perplexity)\b/i;

export interface AudienceInput {
  surface: Surface;
  actor: Actor | null;
  /** Whether the request carried a browser session cookie rather than a bearer token. */
  hasSession: boolean;
  userAgent: string | null;
  /** What the client asked for. A browser asks for HTML; an agent asks for JSON or markdown. */
  accept: string | null;
}

export function classify(input: AudienceInput): AudienceClass {
  // MCP is a class of its own regardless of who holds the token: §47 makes it a separate
  // interface, and "how much of this traffic is MCP" is a question §83 asks directly.
  if (input.surface === "mcp") return "agent_mcp";

  if (input.actor !== null) {
    if (input.actor.kind === "agent") return "agent_api";
    // A person with a browser session is reading the site; a person with a bearer token is
    // using the API, and §4.3 makes those different behaviours by the same subject.
    return input.hasSession && input.surface === "web" ? "human_web" : "human_api";
  }

  /*
   * Anonymous. The public read path is anonymous by design (§33.2), so this is most of the
   * traffic and the classification has to be more careful here, not less.
   */
  if (input.userAgent !== null && CRAWLER.test(input.userAgent)) return "crawler";

  // Asking for HTML is what a browser does and what an agent has no reason to do: §48 gives
  // an agent `.md` and `.json` addresses, and §33.5 redirects it there when it asks.
  const wantsHtml = (input.accept ?? "").includes("text/html");
  if (input.surface === "web" && wantsHtml) return "human_web";

  return "unknown";
}

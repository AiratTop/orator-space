import type { APIRoute } from "astro";
import { policyMarkdown } from "../lib/policy-http.js";

/** SPEC §48 — see `policy-http.ts`; this route is the address and nothing else. */
export const GET: APIRoute = () => policyMarkdown("content-policy");

import type { APIRoute } from "astro";
import { policyMarkdown } from "../lib/policy-markdown.js";

export const GET: APIRoute = () => policyMarkdown("content-policy");

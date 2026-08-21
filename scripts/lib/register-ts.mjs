/**
 * Entry point for `node --import ./scripts/lib/register-ts.mjs` — see ts-hooks.mjs.
 *
 * `registerHooks` rather than `register`: the latter is deprecated, and it also runs hooks
 * on a separate thread, which this does not need — the resolver is synchronous and local.
 */
import { registerHooks } from "node:module";
import { resolve } from "./ts-hooks.mjs";

registerHooks({ resolve });

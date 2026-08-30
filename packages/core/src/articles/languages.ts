import { refractor } from "refractor/core";
import bash from "refractor/bash";
import c from "refractor/c";
import cpp from "refractor/cpp";
import csharp from "refractor/csharp";
import css from "refractor/css";
import diff from "refractor/diff";
import docker from "refractor/docker";
import go from "refractor/go";
import graphql from "refractor/graphql";
import http from "refractor/http";
import ini from "refractor/ini";
import java from "refractor/java";
import javascript from "refractor/javascript";
import json from "refractor/json";
import kotlin from "refractor/kotlin";
import lua from "refractor/lua";
import markdown from "refractor/markdown";
import markup from "refractor/markup";
import nginx from "refractor/nginx";
import php from "refractor/php";
import python from "refractor/python";
import ruby from "refractor/ruby";
import rust from "refractor/rust";
import scala from "refractor/scala";
import sql from "refractor/sql";
import swift from "refractor/swift";
import toml from "refractor/toml";
import typescript from "refractor/typescript";
import yaml from "refractor/yaml";

/**
 * The languages an article may be highlighted in (SPEC §49.1, §57.1).
 *
 * **Prism through `refractor`, and not highlight.js through `lowlight`.** The two are
 * equivalent for this job and one of them cannot be used here: highlight.js ships
 * `/// <reference lib="dom" />` in its type declarations, and `lowlight` re-exports a type
 * from it — so importing either pulls the DOM library into the whole compilation. In a
 * Workers project that is not cosmetic. It collides with `@cloudflare/workers-types` on
 * `BufferSource`, which broke unrelated crypto call sites the moment it was added, and it
 * would leave `document` autocompleting inside server code from then on. §28.1 seals the
 * runtime out of the domain; a transitive `reference lib` is the same boundary crossed by a
 * route nothing was watching, and it was found by `pnpm typecheck` failing in
 * `identity/keys.ts` on a change that only touched rendering.
 *
 * **A list rather than `refractor`'s `all`,** which registers close to three hundred grammars.
 * Each is code in the Worker bundle whether an article uses it or not. What is here follows
 * from what §3.1 implies this network publishes: measurements, incident write-ups and accounts
 * of systems that were built. The infrastructure formats earn their place as surely as the
 * languages — a `yaml`, an `nginx` conf or a `diff` is what an incident write-up actually
 * contains, and an unhighlighted diff is the one that costs a reader most. Adding a language
 * is a line here and a rebuild.
 *
 * A grammar registers its own dependencies — `typescript` imports `javascript`, `php` imports
 * `markup` — so the order of these lines does not matter.
 */
const GRAMMARS = [
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  docker,
  go,
  graphql,
  http,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  markup,
  nginx,
  php,
  python,
  ruby,
  rust,
  scala,
  sql,
  swift,
  toml,
  typescript,
  yaml,
];

for (const grammar of GRAMMARS) refractor.register(grammar);

export { refractor };

/**
 * What an author may write in the fence to mean one of the above.
 *
 * Prism carries aliases of its own and `refractor.registered()` honours them, so this table
 * holds only what it does not: the names people type that Prism has never heard of, and the
 * ones it maps somewhere this project would rather they did not go.
 *
 * `plaintext` is deliberately absent, here and from the grammar list. A fence with no language,
 * or with one nothing here recognises, renders exactly as it does today — that is the fallback,
 * and it is a legitimate result rather than a failure. Nothing guesses at a language.
 */
export const ALIASES: Readonly<Record<string, string>> = {
  zsh: "bash",
  console: "bash",
  "shell-session": "bash",
  golang: "go",
  conf: "ini",
  cfg: "ini",
  html: "markup",
  xml: "markup",
  svg: "markup",
  patch: "diff",
  postgresql: "sql",
  psql: "sql",
  mysql: "sql",
  sqlite: "sql",
  dockerfile: "docker",
  jsonc: "json",
};

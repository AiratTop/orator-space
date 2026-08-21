/**
 * Lets a plain Node script import the workspace's TypeScript sources.
 *
 * The repository writes imports with a `.js` extension, which is what TypeScript's
 * NodeNext resolution and every bundler here expect. Node's own type stripping does not
 * rewrite the specifier, so `./errors.js` does not find `errors.ts`. This maps the two.
 *
 * Twenty lines rather than a dependency (§74): the alternative is a runtime like tsx in
 * the tree for the sake of two build scripts.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, format: "module-typescript", shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

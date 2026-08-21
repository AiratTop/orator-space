#!/usr/bin/env node
/** Loads the development fixture. Requires `pnpm dev` to be running. */
const base = process.argv[2] ?? "http://localhost:8787";

try {
  const response = await fetch(`${base}/dev/seed`, { method: "POST" });
  const body = await response.json();
  if (!response.ok) {
    console.error(`seed failed (${response.status}):`, JSON.stringify(body, null, 2));
    process.exit(1);
  }
  console.log("seeded:", JSON.stringify(body, null, 2));
} catch (error) {
  console.error(`could not reach ${base} — is \`pnpm dev\` running?`);
  console.error(String(error?.message ?? error));
  process.exit(1);
}

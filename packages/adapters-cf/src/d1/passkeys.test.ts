import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCredentialRepo } from "./passkeys.js";
import { createD1Database } from "./database.js";

/**
 * Removing one credential, against a real database (SPEC §9.1, §9.2, §68).
 *
 * The service establishes ownership from the listing before it calls this, and that is where
 * the "is this yours" answer belongs. The statement is scoped anyway, and this asserts the
 * scoping rather than the service — because the one thing this write must never do is delete
 * a credential belonging to somebody else, and a `WHERE` clause missing half its condition
 * looks exactly like one that has it.
 *
 * §68's rule is the second reason to test it here: the in-memory double implements the same
 * method, and this week produced two doubles that were quietly more permissive than the
 * adapter they stood for. A test the double cannot influence is what tells them apart.
 */

const repo = () => createCredentialRepo(env.DB);
const db = () => createD1Database(env.DB);
const AT = "2026-08-29T12:00:00.000Z";

async function principal(id: string, username: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO principals (id, kind, username, username_skeleton, created_at, updated_at)
     VALUES (?, 'human', ?, ?, ?, ?)`,
  )
    .bind(id, username, username, AT, AT)
    .run();
}

async function credential(id: string, principalId: string): Promise<void> {
  await db().commit([
    repo().insert({
      id: id as never,
      principalId: principalId as never,
      credentialId: `cred-${id}`,
      publicKey: `key-${id}`,
      signCount: 0,
      transports: "internal",
      aaguid: null,
      label: `label-${id}`,
      backedUp: true,
      createdAt: AT,
    }),
  ]);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM webauthn_credentials");
  await principal("PA", "owner-a");
  await principal("PB", "owner-b");
});

describe("removing one credential", () => {
  it("removes the named one and leaves the others", async () => {
    await credential("C1", "PA");
    await credential("C2", "PA");

    await db().commit([repo().deleteOne("C1", "PA")]);

    expect((await repo().listFor("PA")).map((row) => row.id)).toEqual(["C2"]);
  });

  it("will not remove a credential belonging to somebody else", async () => {
    await credential("C9", "PB");

    await db().commit([repo().deleteOne("C9", "PA")]);

    expect(await repo().listFor("PB")).toHaveLength(1);
  });

  it("round-trips what the page shows: label, backup state and the dates", async () => {
    await credential("C1", "PA");

    const [row] = await repo().listFor("PA");
    expect(row?.label).toBe("label-C1");
    expect(row?.backedUp).toBe(true);
    expect(row?.lastUsedAt).toBeNull();
  });
});

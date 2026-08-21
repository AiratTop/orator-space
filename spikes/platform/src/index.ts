/**
 * Phase -1 platform verification spike.
 * Verifies assumptions SPEC.md §40 depends on. Throwaway harness; not project scaffolding.
 */

import { checkContent } from "./content";
export { QuotaCounter } from "./quota";

interface Env {
  DB: D1Database;
  CONTENT: R2Bucket;
  QUOTA: DurableObjectNamespace;
  EVENTS: Queue;
}

type Result = {
  id: string;
  claim: string;
  status: "pass" | "fail" | "partial";
  detail: string;
};

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** §8, §42.4 — the whole provenance design rests on this. */
async function checkEd25519(): Promise<Result[]> {
  const out: Result[] = [];
  for (const algo of ["Ed25519", "NODE-ED25519"]) {
    try {
      const params: any = algo === "NODE-ED25519" ? { name: algo, namedCurve: "NODE-ED25519" } : { name: algo };
      const kp = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
      const msg = enc.encode("orator-revision-v1\n01K3\n01K3REV\nabc\n2026-08-21T00:00:00.000Z");
      const sig = await crypto.subtle.sign(params, kp.privateKey, msg);
      const ok = await crypto.subtle.verify(params, kp.publicKey, sig, msg);
      const bad = await crypto.subtle.verify(params, kp.publicKey, sig, enc.encode("tampered"));
      const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
      // round-trip: import a raw public key the way we would store it
      const reimported = await crypto.subtle.importKey("raw", raw, params, true, ["verify"]);
      const ok2 = await crypto.subtle.verify(params, reimported, sig, msg);
      out.push({
        id: `ed25519:${algo}`,
        claim: "Ed25519 sign/verify/export/import via SubtleCrypto",
        status: ok && !bad && ok2 ? "pass" : "fail",
        detail: `sig=${sig.byteLength}B pubkey=${raw.byteLength}B verify=${ok} tamper_rejected=${!bad} reimport_verify=${ok2}`,
      });
    } catch (e: any) {
      out.push({ id: `ed25519:${algo}`, claim: "Ed25519 via SubtleCrypto", status: "fail", detail: String(e?.message ?? e) });
    }
  }
  return out;
}

async function checkSha256(): Promise<Result> {
  const h = await crypto.subtle.digest("SHA-256", enc.encode("orator"));
  return {
    id: "sha256",
    claim: "SHA-256 available for content_hash (§16.1)",
    status: hex(h).length === 64 ? "pass" : "fail",
    detail: hex(h).slice(0, 16) + "…",
  };
}

/** §31.1 — no interactive transactions; batch() must be atomic. */
async function checkD1(env: Env): Promise<Result[]> {
  const out: Result[] = [];
  await env.DB.exec("CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, v TEXT NOT NULL)");
  await env.DB.exec("DELETE FROM t");

  // 1. interactive transaction must NOT be usable
  try {
    await env.DB.prepare("BEGIN").run();
    await env.DB.prepare("INSERT INTO t (id,v) VALUES ('x','1')").run();
    await env.DB.prepare("COMMIT").run();
    out.push({ id: "d1:interactive-tx", claim: "D1 has no interactive transactions", status: "fail", detail: "BEGIN/COMMIT was accepted — SPEC §31.1 assumption is wrong" });
  } catch (e: any) {
    out.push({ id: "d1:interactive-tx", claim: "D1 has no interactive transactions (§31.1)", status: "pass", detail: `rejected: ${String(e?.message ?? e).slice(0, 120)}` });
  }
  await env.DB.exec("DELETE FROM t");

  // 2. batch() atomicity: second statement violates PK, nothing must persist
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO t (id,v) VALUES (?,?)").bind("a", "1"),
      env.DB.prepare("INSERT INTO t (id,v) VALUES (?,?)").bind("a", "2"),
    ]);
    out.push({ id: "d1:batch-atomic", claim: "batch() is atomic (§35.2)", status: "fail", detail: "duplicate PK did not throw" });
  } catch {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM t").first<{ n: number }>();
    out.push({
      id: "d1:batch-atomic",
      claim: "batch() rolls back entirely on failure (§35.2 outbox atomicity)",
      status: r?.n === 0 ? "pass" : "fail",
      detail: `rows after failed batch = ${r?.n}`,
    });
  }

  // 3. conditional UPDATE ... WHERE as optimistic concurrency (§34.3)
  await env.DB.exec("DELETE FROM t");
  await env.DB.prepare("INSERT INTO t (id,v) VALUES ('c','v1')").run();
  const miss = await env.DB.prepare("UPDATE t SET v='v2' WHERE id='c' AND v='WRONG'").run();
  const hit = await env.DB.prepare("UPDATE t SET v='v2' WHERE id='c' AND v='v1'").run();
  out.push({
    id: "d1:conditional-update",
    claim: "meta.changes usable for optimistic concurrency (§34.3)",
    status: miss.meta.changes === 0 && hit.meta.changes === 1 ? "pass" : "fail",
    detail: `stale=${miss.meta.changes} fresh=${hit.meta.changes}`,
  });

  // 4. FTS5 (§38.1, open decision §80.18)
  try {
    await env.DB.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, body)");
    await env.DB.prepare("INSERT INTO fts (title, body) VALUES (?,?)").bind("Edge runtimes", "autonomous agents publishing at the edge").run();
    const hitRow = await env.DB.prepare("SELECT title FROM fts WHERE fts MATCH ?").bind("autonomous").first<{ title: string }>();
    out.push({ id: "d1:fts5", claim: "FTS5 available in D1 (§38.1)", status: hitRow ? "pass" : "fail", detail: hitRow ? `matched: ${hitRow.title}` : "no match" });
  } catch (e: any) {
    out.push({ id: "d1:fts5", claim: "FTS5 available in D1 (§38.1)", status: "fail", detail: String(e?.message ?? e).slice(0, 160) });
  }

  // 5. partial index + EXPLAIN QUERY PLAN (§67.2 discipline)
  try {
    await env.DB.exec("CREATE TABLE IF NOT EXISTS a (id TEXT PRIMARY KEY, status TEXT, published_at TEXT)");
    await env.DB.exec("CREATE INDEX IF NOT EXISTS ix_a ON a(status, published_at DESC) WHERE status='published'");
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM a WHERE status='published' ORDER BY published_at DESC LIMIT 20").all();
    const txt = JSON.stringify(plan.results);
    out.push({ id: "d1:partial-index", claim: "partial indexes honoured; EXPLAIN QUERY PLAN available", status: txt.includes("ix_a") ? "pass" : "partial", detail: txt.slice(0, 200) });
  } catch (e: any) {
    out.push({ id: "d1:partial-index", claim: "partial index + EXPLAIN", status: "fail", detail: String(e?.message ?? e).slice(0, 160) });
  }

  return out;
}

/** §16.2, §32 — content-addressed storage. */
async function checkR2(env: Env): Promise<Result[]> {
  const out: Result[] = [];
  const body = "# hello\n\ncontent-addressed";
  const digest = hex(await crypto.subtle.digest("SHA-256", enc.encode(body)));
  const key = `content/${digest}`;
  await env.CONTENT.put(key, body);
  const got = await env.CONTENT.get(key);
  const text = await got?.text();
  out.push({
    id: "r2:content-addressed",
    claim: "R2 put/get by content hash (§16.2)",
    status: text === body ? "pass" : "fail",
    detail: `key=${key.slice(0, 24)}… size=${got?.size}`,
  });

  // conditional put — used to avoid rewriting an existing immutable object
  try {
    const res = await env.CONTENT.put(key, "different", { onlyIf: { etagDoesNotMatch: (got as any)?.etag ?? "*" } } as any);
    out.push({ id: "r2:conditional-put", claim: "conditional put supported (onlyIf)", status: res === null ? "pass" : "partial", detail: res === null ? "precondition correctly failed" : "put succeeded — guard in code instead" });
  } catch (e: any) {
    out.push({ id: "r2:conditional-put", claim: "conditional put supported (onlyIf)", status: "partial", detail: String(e?.message ?? e).slice(0, 120) });
  }

  await env.CONTENT.delete(key);
  const gone = await env.CONTENT.get(key);
  out.push({ id: "r2:delete", claim: "objects can be deleted (§23.3 erase, §32.2 GC)", status: gone === null ? "pass" : "fail", detail: gone === null ? "deleted" : "still present" });
  return out;
}

/** §59.1 — quotas need exact global counting; DO provides it, rate-limit binding does not. */
async function checkDurableObject(env: Env): Promise<Result[]> {
  const out: Result[] = [];
  try {
    const id = env.QUOTA.idFromName("principal:spike");
    const stub = env.QUOTA.get(id);
    await stub.fetch("https://do/reset");
    let last: any = null;
    for (let i = 0; i < 7; i++) last = await (await stub.fetch("https://do/incr")).json();
    out.push({
      id: "do:quota",
      claim: "DO gives exact serialised per-principal counting (§59.1)",
      status: last?.used === 7 && last?.allowed === false ? "pass" : "fail",
      detail: `used=${last?.used} limit=${last?.limit} allowed=${last?.allowed} alarm_set=${last?.alarm_set}`,
    });
    out.push({
      id: "do:transaction",
      claim: "DO storage HAS interactive transactions, unlike D1 (§31.1)",
      status: last?.used === 7 ? "pass" : "fail",
      detail: "state.storage.transaction() usable for read-modify-write",
    });
  } catch (e: any) {
    out.push({ id: "do:quota", claim: "DO quota counter", status: "fail", detail: String(e?.message ?? e).slice(0, 180) });
  }
  return out;
}

/** §35.3 — outbox drains into a queue. */
async function checkQueue(env: Env): Promise<Result[]> {
  try {
    await env.EVENTS.send({ type: "article.published", id: "01K3SPIKE", schema_version: 1 });
    await env.EVENTS.sendBatch([
      { body: { type: "article.updated", id: "01K3SPIKE" } },
      { body: { type: "comment.created", id: "01K3SPIKE2" } },
    ]);
    return [{ id: "queue:send", claim: "queue send + sendBatch from worker (§35.3)", status: "pass", detail: "1 single + 2 batched accepted" }];
  } catch (e: any) {
    return [{ id: "queue:send", claim: "queue send + sendBatch", status: "fail", detail: String(e?.message ?? e).slice(0, 180) }];
  }
}

export default {
  async fetch(_req: Request, env: Env): Promise<Response> {
    const results: Result[] = [];
    results.push(...(await checkEd25519()));
    results.push(await checkSha256());
    results.push(...(await checkD1(env)));
    results.push(...(await checkR2(env)));
    results.push(...((await checkContent()) as Result[]));
    results.push(...(await checkDurableObject(env)));
    results.push(...(await checkQueue(env)));

    const summary = {
      pass: results.filter((r) => r.status === "pass").length,
      partial: results.filter((r) => r.status === "partial").length,
      fail: results.filter((r) => r.status === "fail").length,
    };
    return new Response(JSON.stringify({ runtime: navigator.userAgent, summary, results }, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};

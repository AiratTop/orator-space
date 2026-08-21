/** §59.1 — quota counter as a Durable Object: serialised per principal, alarm-driven reset. */
export class QuotaCounter implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/reset") {
      await this.state.storage.deleteAll();
      return Response.json({ ok: true });
    }
    // storage.transaction() exists here — the interactive transaction D1 lacks (§31.1)
    const used = await this.state.storage.transaction(async (txn) => {
      const n = ((await txn.get<number>("used")) ?? 0) + 1;
      await txn.put("used", n);
      return n;
    });
    const limit = 5;
    if (used === 1) await this.state.storage.setAlarm(Date.now() + 60_000);
    const alarm = await this.state.storage.getAlarm();
    return Response.json({ used, limit, allowed: used <= limit, alarm_set: alarm !== null });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

// Integration tests against a real PostgreSQL database. Skipped when DATABASE_URL is not set.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { processAll, processPayment } from "../src/agent";
import { generate } from "../src/data/generate";
import { offlineExtract } from "../src/extract";
import { PgStore } from "../src/pg-store";
import { createApp } from "../src/server";
import { MemoryStore } from "../src/store";

const url = process.env.DATABASE_URL;
const extract = async (t: string) => offlineExtract(t);

describe.skipIf(!url)("PostgreSQL store", () => {
  let store: PgStore;
  const data = generate(7, 60);
  beforeAll(async () => { store = PgStore.connect(url); await store.reset(); await store.load(data); });
  afterAll(async () => { await store.close(); });

  it("makes exactly the same decisions as the in-memory store", async () => {
    const pgDecisions = await processAll(store, data.payments, extract);
    const memDecisions = await processAll(new MemoryStore(data.customers, data.invoices), data.payments, extract);
    const strip = (ds: typeof pgDecisions) => ds.map(d => ({ id: d.paymentId, action: d.action, rule: d.rule, apps: d.applications }));
    expect(strip(pgDecisions)).toEqual(strip(memDecisions));
  });

  it("never applies the same payment twice", async () => {
    const before = (await store.pool.query("SELECT sum(balance)::float AS s FROM invoices")).rows[0].s;
    const p = data.payments[0];
    await processPayment(store, p, extract);                   // a retry of an already-processed payment
    const after = (await store.pool.query("SELECT sum(balance)::float AS s FROM invoices")).rows[0].s;
    expect(after).toBe(before);
  });

  it("keeps the books balanced: cash applied plus discounts equals the drop in open balances", async () => {
    const { rows } = await store.pool.query(`
      SELECT (SELECT sum(amount - balance) FROM invoices)::float AS reduced,
             (SELECT coalesce(sum(amount + discount), 0) FROM applications)::float AS applied`);
    expect(rows[0].reduced).toBeCloseTo(rows[0].applied, 2);
  });

  it("applies a reviewer's approval, once", async () => {
    const q = await store.reviewQueue();
    const withSuggestion = q.find(r => r.suggestion.length > 0);
    expect(withSuggestion).toBeDefined();
    await store.approve(withSuggestion.payment_id, "ar.clerk@example.com");
    await expect(store.approve(withSuggestion.payment_id, "ar.clerk@example.com")).rejects.toThrow("already approved");
  });
});

describe.skipIf(!url)("API", () => {
  let store: PgStore, server: Server, base = "";
  beforeAll(async () => {
    store = PgStore.connect(url); await store.reset();
    const data = generate(11, 10); await store.load({ ...data, payments: [] });
    server = createApp(store, extract).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    (globalThis as any).__data = data;
  });
  afterAll(async () => { server.close(); await store.close(); });

  it("ingests payments, explains decisions, and reports metrics", async () => {
    const data = (globalThis as any).__data;
    for (const p of data.payments) {
      const res = await fetch(`${base}/payments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
      expect(res.status).toBe(201);
    }
    const d = await (await fetch(`${base}/payments/${data.payments[0].id}/decision`)).json();
    expect(d.trace.length).toBeGreaterThan(1);
    const m = await (await fetch(`${base}/metrics`)).json();
    expect(m.payments).toBe(data.payments.length);
  });

  it("rejects bad input", async () => {
    const res = await fetch(`${base}/payments`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", amount: -5, method: "cash" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).details.length).toBeGreaterThan(2);
  });
});

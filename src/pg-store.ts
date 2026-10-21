// PostgreSQL store. Each payment is recorded in one transaction: the decision,
// its trace, and (for auto-applied payments) the cash applications and new
// invoice balances either all commit or none do. The unique key on
// decisions.payment_id makes retries safe: a payment can never be applied twice.
import pg from "pg";
import type { Store } from "./store";
import type { Customer, Dataset, Decision, Invoice } from "./types";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), po_number TEXT,
  invoice_date DATE NOT NULL, amount NUMERIC(12,2) NOT NULL, balance NUMERIC(12,2) NOT NULL CHECK (balance >= 0),
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0, discount_days INT NOT NULL DEFAULT 10
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, received_date DATE NOT NULL, amount NUMERIC(12,2) NOT NULL, method TEXT NOT NULL,
  payer_name TEXT NOT NULL, remittance TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS decisions (
  payment_id TEXT PRIMARY KEY REFERENCES payments(id), action TEXT NOT NULL CHECK (action IN ('auto_apply','review')),
  customer_id TEXT REFERENCES customers(id), confidence NUMERIC(4,3) NOT NULL, rule TEXT NOT NULL, reason TEXT NOT NULL,
  trace JSONB NOT NULL, suggestion JSONB NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open',
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_by TEXT
);
CREATE TABLE IF NOT EXISTS applications (
  payment_id TEXT NOT NULL REFERENCES payments(id), invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount NUMERIC(12,2) NOT NULL, discount NUMERIC(12,2) NOT NULL DEFAULT 0, applied_by TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (payment_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS invoices_open ON invoices (customer_id) WHERE balance > 0;
CREATE INDEX IF NOT EXISTS decisions_queue ON decisions (status) WHERE action = 'review';
`;

const num = (v: unknown) => Number(v);

export class PgStore implements Store {
  constructor(readonly pool: pg.Pool) {}

  static connect(url = process.env.DATABASE_URL) {
    if (!url) throw new Error("DATABASE_URL is not set");
    return new PgStore(new pg.Pool({ connectionString: url, max: 5 }));
  }

  async migrate() { await this.pool.query(SCHEMA); }

  async reset() {
    await this.pool.query("DROP TABLE IF EXISTS applications, decisions, payments, invoices, customers CASCADE");
    await this.migrate();
  }

  async load(data: Dataset) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      for (const x of data.customers) await c.query("INSERT INTO customers VALUES ($1,$2) ON CONFLICT DO NOTHING", [x.id, x.name]);
      for (const i of data.invoices) {
        await c.query("INSERT INTO invoices VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
          [i.id, i.customerId, i.poNumber, i.invoiceDate, i.amount, i.balance, i.discountPct, i.discountDays]);
      }
      for (const p of data.payments) {
        await c.query("INSERT INTO payments VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [p.id, p.receivedDate, p.amount, p.method, p.payerName, p.remittance]);
      }
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  async customers(): Promise<Customer[]> {
    return (await this.pool.query("SELECT id, name FROM customers ORDER BY id")).rows;
  }

  async openInvoices(): Promise<Invoice[]> {
    const { rows } = await this.pool.query(
      "SELECT id, customer_id, po_number, to_char(invoice_date,'YYYY-MM-DD') AS d, amount, balance, discount_pct, discount_days FROM invoices WHERE balance > 0 ORDER BY id");
    return rows.map(r => ({ id: r.id, customerId: r.customer_id, poNumber: r.po_number, invoiceDate: r.d, amount: num(r.amount),
                            balance: num(r.balance), discountPct: num(r.discount_pct), discountDays: r.discount_days }));
  }

  async record(d: Decision) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const ins = await c.query(
        `INSERT INTO decisions (payment_id, action, customer_id, confidence, rule, reason, trace, suggestion, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (payment_id) DO NOTHING`,
        [d.paymentId, d.action, d.customerId, d.confidence, d.rule, d.reason, JSON.stringify(d.trace),
         JSON.stringify(d.applications), d.action === "auto_apply" ? "applied" : "open"]);
      if (ins.rowCount === 0) { await c.query("ROLLBACK"); return; }   // already decided: idempotent
      if (d.action === "auto_apply") await this.applyCash(c, d.paymentId, d.applications, "agent");
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  private async applyCash(c: pg.PoolClient, paymentId: string, apps: Decision["applications"], by: string) {
    for (const a of apps) {
      // Row lock plus a balance check, so two workers can never over-apply one invoice.
      const upd = await c.query(
        "UPDATE invoices SET balance = balance - $2::numeric - $3::numeric WHERE id = $1 AND balance >= $2::numeric + $3::numeric - 0.004 RETURNING balance",
        [a.invoiceId, a.amount, a.discount]);
      if (upd.rowCount === 0) throw new Error(`invoice ${a.invoiceId} no longer has enough open balance`);
      await c.query("INSERT INTO applications VALUES ($1,$2,$3,$4,$5)", [paymentId, a.invoiceId, a.amount, a.discount, by]);
    }
  }

  /** A person approves the agent's suggested match from the review queue, and the cash is applied. */
  async approve(paymentId: string, reviewer: string) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const { rows } = await c.query("SELECT suggestion, status FROM decisions WHERE payment_id = $1 FOR UPDATE", [paymentId]);
      if (!rows.length) throw new Error("no decision for this payment");
      if (rows[0].status !== "open") throw new Error(`already ${rows[0].status}`);
      const suggestion = rows[0].suggestion as Decision["applications"];
      if (!suggestion.length) throw new Error("the agent made no suggestion for this payment; apply it manually");
      await this.applyCash(c, paymentId, suggestion, reviewer);
      await c.query("UPDATE decisions SET status = 'approved', resolved_by = $2 WHERE payment_id = $1", [paymentId, reviewer]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  async reviewQueue() {
    return (await this.pool.query(
      `SELECT d.payment_id, p.payer_name, p.amount::float, p.remittance, d.rule, d.reason, d.confidence::float, d.suggestion
       FROM decisions d JOIN payments p ON p.id = d.payment_id
       WHERE d.action = 'review' AND d.status = 'open' ORDER BY p.amount DESC`)).rows;
  }

  async metrics() {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS payments,
              count(*) FILTER (WHERE action = 'auto_apply')::int AS auto_applied,
              count(*) FILTER (WHERE action = 'review' AND status = 'open')::int AS in_review,
              coalesce(sum(p.amount) FILTER (WHERE action = 'auto_apply'), 0)::float AS cash_auto_applied
       FROM decisions d JOIN payments p ON p.id = d.payment_id`);
    const byRule = (await this.pool.query("SELECT rule, action, count(*)::int AS n FROM decisions GROUP BY 1,2 ORDER BY n DESC")).rows;
    return { ...rows[0], straight_through_rate: rows[0].payments ? rows[0].auto_applied / rows[0].payments : 0, by_rule: byRule };
  }

  async close() { await this.pool.end(); }
}

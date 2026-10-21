// Where invoices live and where decisions get recorded.
//
// Store is the interface. MemoryStore backs the evals and the browser demo.
// PgStore (src/pg-store.ts) is the PostgreSQL version used by the API.
import type { Customer, Decision, Invoice } from "./types";

export interface Store {
  customers(): Promise<Customer[]>;
  openInvoices(): Promise<Invoice[]>;
  /** Record the decision; apply the cash if it was auto-applied. Must be idempotent per payment. */
  record(decision: Decision, paymentAmount: number): Promise<void>;
}

export class MemoryStore implements Store {
  private invoices: Map<string, Invoice>;
  readonly decisions = new Map<string, Decision>();

  constructor(private readonly cust: Customer[], invoices: Invoice[]) {
    this.invoices = new Map(invoices.map(i => [i.id, { ...i }]));
  }
  async customers() { return this.cust; }
  async openInvoices() { return [...this.invoices.values()].filter(i => i.balance > 0.004); }
  async record(d: Decision) {
    if (this.decisions.has(d.paymentId)) return;            // idempotent: a retry never applies cash twice
    this.decisions.set(d.paymentId, d);
    if (d.action !== "auto_apply") return;
    for (const a of d.applications) {
      const inv = this.invoices.get(a.invoiceId)!;
      inv.balance = Math.round((inv.balance - a.amount - a.discount) * 100) / 100;
    }
  }
}

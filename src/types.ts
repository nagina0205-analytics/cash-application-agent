// Core shapes for cash application: customers, invoices, payments, and the agent's decisions.

export interface Customer {
  id: string;
  name: string;                 // legal name, e.g. "Ridgeline Builders LLC"
}

export interface Invoice {
  id: string;                   // invoice number, e.g. "10234"
  customerId: string;
  poNumber: string | null;      // the contractor's purchase order
  invoiceDate: string;          // YYYY-MM-DD
  amount: number;               // original amount in dollars
  balance: number;              // open balance
  discountPct: number;          // early-pay discount, e.g. 2 for "2/10 net 30"
  discountDays: number;         // days the discount is valid, e.g. 10
}

export interface Payment {
  id: string;
  receivedDate: string;
  amount: number;
  method: "ach" | "check" | "card";
  payerName: string;            // as written by the bank or on the check
  remittance: string;           // free text from the memo line, email or check stub
}

/** What the extractor reads out of the remittance text. */
export interface Extraction {
  invoiceNumbers: string[];
  poNumbers: string[];
  discountPctClaimed: number | null;
  source: "offline" | "llm";
}

export interface Application {
  invoiceId: string;
  amount: number;               // cash applied to this invoice
  discount: number;             // early-pay discount written off on this invoice
}

export interface Decision {
  paymentId: string;
  action: "auto_apply" | "review";
  customerId: string | null;
  applications: Application[];
  confidence: number;
  rule: string;                 // which rule decided it
  reason: string;               // plain-language reason, shown to the AR team
  trace: string[];              // every step, for observability and audits
}

/** The right answer for a generated payment, used only by the evals. */
export interface Truth {
  paymentId: string;
  scenario: string;
  expected: "apply" | "review";
  customerId: string | null;
  applications: { invoiceId: string; amount: number }[];
}

export interface Dataset {
  customers: Customer[];
  invoices: Invoice[];
  payments: Payment[];
  truth: Truth[];
}

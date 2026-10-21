// A hand-written stress set: 20 payments from real accounts receivable situations
// that the synthetic generator never produces. Each expected outcome is what a
// careful AR clerk would do. This set exists to find failures, not to score well.
import type { Customer, Dataset, Invoice, Payment, Truth } from "../types";

const customers: Customer[] = [
  { id: "C001", name: "Ridgeline Builders LLC" }, { id: "C002", name: "Summit Concrete Inc" },
  { id: "C003", name: "Harbor Point Construction" }, { id: "C004", name: "Westgate Renovation Co" },
];

let n = 30000;
const invoices: Invoice[] = [];
const inv = (customerId: string, amount: number, o: Partial<Invoice> = {}): Invoice => {
  const i: Invoice = { id: String(++n), customerId, poNumber: null, invoiceDate: "2026-09-01", amount, balance: amount,
                       discountPct: 0, discountDays: 10, ...o };
  invoices.push(i);
  return i;
};
// Background invoices so amount matching has something to get confused by
inv("C001", 1810.0); inv("C001", 6420.55); inv("C002", 990.0); inv("C003", 12500.0); inv("C004", 3300.0);

const payments: Payment[] = [];
const truth: Truth[] = [];
let p = 0;
const add = (scenario: string, customerIdForTruth: string | null, payer: string, amount: number, remittance: string,
             expected: "apply" | "review", apps: Invoice[] | { invoiceId: string; amount: number }[] = [], received = "2026-10-05") => {
  const id = `STRESS-${String(++p).padStart(2, "0")}`;
  payments.push({ id, receivedDate: received, amount, method: "check", payerName: payer, remittance });
  const applications = apps.map(a => "id" in a ? { invoiceId: a.id, amount: a.balance } : a);
  truth.push({ paymentId: id, scenario, expected, customerId: expected === "apply" ? customerIdForTruth : customerIdForTruth, applications: expected === "apply" ? applications : [] });
};

const a1 = inv("C001", 2340.0);
add("check number next to invoice", "C001", "RIDGELINE BLDRS", 2340.0, `Check 104523 for inv ${a1.id}`, "apply", [a1]);
const a2 = inv("C001", 815.25);
add("invoice with dash prefix", "C001", "RIDGELINE BLDRS", 815.25, `INV-${a2.id}`, "apply", [a2]);
const a3 = inv("C001", 4410.0);
add("misspelled payer, good reference", "C001", "RIDGLINE BUILDRS", 4410.0, `INV ${a3.id}`, "apply", [a3]);
const a4 = inv("C001", 1500.0);
add("payer pays another customer's invoice", "C001", "SUMMIT CONCRETE", 1500.0, `INV ${a4.id}`, "review");
const a5 = inv("C002", 6000.0);
add("installment payment", "C002", "SUMMIT CONCRETE", 3000.0, `INV ${a5.id} payment 1 of 2`, "review");
const a6 = inv("C002", 1234.56);
add("dollar amount written in remittance", "C002", "SUMMIT CONCRETE", 1234.56, `pd ${a6.id} $1,234.56`, "apply", [a6]);
const a7 = inv("C002", 2750.0);
add("leading zeros on invoice number", "C002", "SUMMIT CONCRETE", 2750.0, `INV 00${a7.id}`, "apply", [a7]);
const a8 = inv("C003", 5000.0, { discountPct: 2, invoiceDate: "2026-10-01" }), a9 = inv("C003", 2200.0, { invoiceDate: "2026-10-01" });
add("discount on only one of two invoices", "C003", "HARBOR PT CONST", 4900.0 + 2200.0, `${a8.id} ${a9.id} less 2% where allowed`, "apply",
    [{ invoiceId: a8.id, amount: 4900.0 }, { invoiceId: a9.id, amount: 2200.0 }]);
const a10 = inv("C003", 640.0), a11 = inv("C003", 880.0);
add("per-invoice amounts listed", "C003", "HARBOR PT CONST", 1520.0, `${a10.id} $640.00; ${a11.id} $880.00`, "apply", [a10, a11]);
const a12 = inv("C003", 3150.0); inv("C003", 2875.0);
add("customer quoted the wrong invoice", "C003", "HARBOR PT CONST", 2875.0, `INV ${a12.id}`, "review");
const a13 = inv("C004", 1100.0), a14 = inv("C004", 2300.0), a15 = inv("C004", 450.0);
add("three invoices, no reference", "C004", "WESTGATE RENOV", 3850.0, "materials sept", "apply", [a13, a14, a15]);
const a16 = inv("C004", 2000.0);
add("card fee deducted", "C004", "WESTGATE RENOV", 1940.0, `INV ${a16.id} card fee deducted`, "review");
const a17 = inv("C004", 975.0, { balance: 0 });
add("duplicate payment for a paid invoice", "C004", "WESTGATE RENOV", 975.0, `INV ${a17.id}`, "review");
const a18 = inv("C004", 7780.0);
add("construction pay application language", "C004", "WESTGATE RENOV", 7780.0, "Pay app #3 Elm St job", "apply", [a18]);
const a19 = inv("C001", 3200.0, { poNumber: "PO-4471" }), a20 = inv("C001", 1800.0, { poNumber: "PO-4471" });
add("one PO split across two invoices", "C001", "RIDGELINE BLDRS", 5000.0, "PO 4471", "apply", [a19, a20]);
const a21 = inv("C002", 3600.0);
add("joint check from a bank", "C002", "FIRST REGIONAL BANK JOINT CHECK", 3600.0, `INV ${a21.id}`, "apply", [a21]);
const a22 = inv("C002", 1999.0);
add("year in remittance", "C002", "SUMMIT CONCRETE", 1999.0, `INV ${a22.id} Oct 2026`, "apply", [a22]);
const a23 = inv("C003", 2610.0);
add("ZIP code in remittance", "C003", "HARBOR PT CONST", 2610.0, `INV ${a23.id} Wichita KS 67202`, "apply", [a23]);
const a24 = inv("C001", 1000.01, { discountPct: 2, invoiceDate: "2026-10-01" }), a25 = inv("C001", 1000.01, { discountPct: 2, invoiceDate: "2026-10-01" });
add("discount rounded on the total", "C001", "RIDGELINE BLDRS", Math.round((1000.01 + 1000.01) * 0.98 * 100) / 100, `${a24.id} ${a25.id} 2% disc`, "apply",
    [{ invoiceId: a24.id, amount: 980.01 }, { invoiceId: a25.id, amount: 980.01 }]);
const a26 = inv("C002", 455.0);
add("phone number in remittance", "C002", "SUMMIT CONCRETE", 455.0, `INV ${a26.id} questions call 316-555-0142`, "apply", [a26]);

export function stressSet(): Dataset {
  return { customers, invoices: invoices.map(i => ({ ...i })), payments, truth };
}

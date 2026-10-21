// Synthetic accounts receivable data for a construction materials supplier.
//
// Each payment is built from a scenario with a known right answer, so the
// agent can be scored. Same seed, same data. All names and numbers are fake.
import type { Customer, Dataset, Invoice, Payment, Truth } from "../types";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANIES: [string, string][] = [
  ["Ridgeline Builders LLC", "RIDGELINE BLDRS"], ["Summit Concrete Inc", "SUMMIT CONCRETE"],
  ["Harbor Point Construction", "HARBOR PT CONST"], ["Ironclad Framing Co", "IRONCLAD FRAMING"],
  ["Bluestone Paving LLC", "BLUESTONE PAVING"], ["Cedar Creek Homes", "CEDAR CRK HOMES"],
  ["Granite State Contractors", "GRANITE ST CONTR"], ["Northfield Masonry Inc", "NORTHFIELD MASONRY"],
  ["Prairie Roofing Co", "PRAIRIE ROOFING"], ["Keystone Electrical LLC", "KEYSTONE ELEC"],
  ["Valley Plumbing Supply", "VALLEY PLBG"], ["Oakmont Builders Group", "OAKMONT BLDRS GRP"],
  ["Redrock Excavation Inc", "REDROCK EXCAV"], ["Lakeshore Drywall LLC", "LAKESHORE DRYWALL"],
  ["Pioneer Steel Erectors", "PIONEER STEEL"], ["Westgate Renovation Co", "WESTGATE RENOV"],
  ["Copperline HVAC Inc", "COPPERLINE HVAC"], ["Timberland Decks LLC", "TIMBERLAND DECKS"],
  ["Brightside Glass & Glazing", "BRIGHTSIDE GLASS"], ["Meadowbrook Landscapes", "MEADOWBROOK LNDSCP"],
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function generate(seed: number, paymentsWanted: number): Dataset {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const customers: Customer[] = COMPANIES.map(([name], i) => ({ id: `C${String(i + 1).padStart(3, "0")}`, name }));
  const bankName = new Map(COMPANIES.map(([name, bank], i) => [customers[i].id, r() < 0.6 ? bank : name.toUpperCase()]));

  const invoices: Invoice[] = [];
  let invNo = seed * 10000 + 1000;
  const newInvoice = (c: Customer, amount?: number): Invoice => {
    const inv: Invoice = {
      id: String(++invNo), customerId: c.id,
      poNumber: r() < 0.7 ? `PO-${Math.floor(1000 + r() * 8999)}` : null,
      invoiceDate: addDays("2026-08-01", Math.floor(r() * 60)),
      amount: amount ?? round2(250 + r() * 24000), balance: 0, discountPct: r() < 0.6 ? 2 : 0, discountDays: 10,
    };
    inv.balance = inv.amount;
    invoices.push(inv);
    return inv;
  };
  // A pool of open invoices per customer that no payment will touch (realistic noise)
  for (const c of customers) for (let k = 0; k < 4; k++) newInvoice(c);

  const payments: Payment[] = [];
  const truth: Truth[] = [];
  const scenarios = [
    "single_invoice", "multi_invoice", "early_pay_discount", "po_reference", "no_reference_unique_amount",
    "no_reference_two_invoices", "payer_name_variant", "short_pay", "overpayment", "unknown_payer",
    "typo_in_invoice_number", "ambiguous_same_amount", "discount_after_deadline",
  ];
  const weights = [16, 10, 9, 8, 7, 5, 9, 7, 4, 5, 6, 5, 4];
  const total = weights.reduce((a, b) => a + b, 0);
  const scenarioFor = () => { let x = r() * total; for (let i = 0; i < scenarios.length; i++) { x -= weights[i]; if (x < 0) return scenarios[i]; } return scenarios[0]; };

  for (let i = 0; i < paymentsWanted; i++) {
    const s = scenarioFor();
    const c = pick(customers);
    const id = `PMT-${seed}-${String(i + 1).padStart(4, "0")}`;
    const method = pick(["ach", "ach", "check", "card"] as const);
    let payer = bankName.get(c.id)!;
    let remit = "", amount = 0, received = "";
    let expected: "apply" | "review" = "apply";
    let apps: { invoiceId: string; amount: number }[] = [];
    let custForTruth: string | null = c.id;

    if (s === "single_invoice" || s === "payer_name_variant") {
      const inv = newInvoice(c);
      received = addDays(inv.invoiceDate, 25 + Math.floor(r() * 20));
      amount = inv.amount;
      remit = pick([`INV ${inv.id}`, `Invoice #${inv.id}`, `inv${inv.id} thank you`, `Payment for invoice ${inv.id}`]);
      if (s === "payer_name_variant") payer = pick([c.name.replace("Builders", "Bldrs").replace("Construction", "Const"), `${c.name.split(" ")[0]} ${c.name.split(" ")[1] ?? ""}`.trim().toUpperCase(), `${c.name}, DBA`]);
      apps = [{ invoiceId: inv.id, amount }];
    } else if (s === "multi_invoice") {
      const n = 2 + Math.floor(r() * 3);
      const invs = Array.from({ length: n }, () => newInvoice(c));
      received = addDays(invs[0].invoiceDate, 35);
      amount = round2(invs.reduce((a, v) => a + v.amount, 0));
      remit = pick([`Inv# ${invs.map(v => v.id).join(", ")}`, `Paying ${invs.map(v => v.id).join(" / ")}`, `INVOICES ${invs.map(v => v.id).join(" ")}`]);
      apps = invs.map(v => ({ invoiceId: v.id, amount: v.amount }));
    } else if (s === "early_pay_discount" || s === "discount_after_deadline") {
      const inv = newInvoice(c); inv.discountPct = 2;
      received = addDays(inv.invoiceDate, s === "early_pay_discount" ? 3 + Math.floor(r() * 6) : 20 + Math.floor(r() * 10));
      amount = round2(inv.amount * 0.98);
      remit = pick([`${inv.id} less 2% disc`, `INV ${inv.id} 2/10 discount taken`, `inv ${inv.id} - 2% early pay`]);
      if (s === "early_pay_discount") apps = [{ invoiceId: inv.id, amount }];
      else expected = "review";   // discount taken after the window: AR has to decide
    } else if (s === "po_reference") {
      const inv = newInvoice(c); inv.poNumber = `PO-${Math.floor(1000 + r() * 8999)}`;
      received = addDays(inv.invoiceDate, 30);
      amount = inv.amount;
      remit = pick([`${inv.poNumber}`, `Per ${inv.poNumber} job materials`, `PO# ${inv.poNumber.replace("PO-", "")}`]);
      apps = [{ invoiceId: inv.id, amount }];
    } else if (s === "no_reference_unique_amount") {
      const inv = newInvoice(c);
      received = addDays(inv.invoiceDate, 30);
      amount = inv.amount;
      remit = pick(["", "payment", "Thank you", "materials"]);
      apps = [{ invoiceId: inv.id, amount }];
    } else if (s === "no_reference_two_invoices") {
      const a = newInvoice(c), b = newInvoice(c);
      received = addDays(b.invoiceDate, 30);
      amount = round2(a.amount + b.amount);
      remit = pick(["", "payment for materials", "acct payment"]);
      apps = [{ invoiceId: a.id, amount: a.amount }, { invoiceId: b.id, amount: b.amount }];
    } else if (s === "short_pay") {
      const inv = newInvoice(c);
      received = addDays(inv.invoiceDate, 30);
      amount = round2(inv.amount - (50 + Math.floor(r() * 900)));
      remit = pick([`INV ${inv.id} short paid - damaged pallet`, `Invoice ${inv.id} partial`, `${inv.id} less returned items`]);
      expected = "review";
    } else if (s === "overpayment") {
      const inv = newInvoice(c);
      received = addDays(inv.invoiceDate, 30);
      amount = round2(inv.amount + 100 + Math.floor(r() * 400));
      remit = `INV ${inv.id}`;
      expected = "review";
    } else if (s === "unknown_payer") {
      const inv = newInvoice(c);
      received = addDays(inv.invoiceDate, 30);
      amount = round2(inv.amount + 37.5);
      payer = pick(["FIRST REGIONAL BANK JOINT CHECK", "MARTINEZ & SONS GC", "ACME GENERAL CONTRACTING"]);
      remit = pick(["joint check", "payment", ""]);
      expected = "review"; custForTruth = null;
    } else if (s === "typo_in_invoice_number") {
      const inv = newInvoice(c);
      received = addDays(inv.invoiceDate, 30);
      amount = inv.amount;
      const typo = inv.id.replace(/0/, "O").replace(/1/, "l");
      remit = pick([`INV ${typo}`, `Invoice #${typo}`]);
      apps = [{ invoiceId: inv.id, amount }];
    } else if (s === "ambiguous_same_amount") {
      const a = newInvoice(c); newInvoice(c, a.amount);
      received = addDays(a.invoiceDate, 30);
      amount = a.amount;
      remit = pick(["", "payment"]);
      expected = "review";
    }
    payments.push({ id, receivedDate: received, amount, method, payerName: payer, remittance: remit });
    truth.push({ paymentId: id, scenario: s, expected, customerId: custForTruth, applications: expected === "apply" ? apps : [] });
  }
  return { customers, invoices, payments, truth };
}

export { fmt };

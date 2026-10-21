// Decide where a payment goes.
//
// The agent auto-applies cash only when the evidence is unambiguous. A wrong
// application is expensive (the customer looks paid when they aren't, or gets
// dunned for money they sent), so anything uncertain goes to the AR team with
// a plain-language reason and a suggested match.
import type { Application, Customer, Decision, Extraction, Invoice, Payment } from "./types";

export const AUTO_APPLY_THRESHOLD = 0.9;
const CENT = 0.01;
const round2 = (n: number) => Math.round(n * 100) / 100;
const same = (a: number, b: number) => Math.abs(a - b) < CENT / 2 + 1e-9;
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------- payer to customer ----------
const ABBREV: Record<string, string> = { bldrs: "builders", const: "construction", contr: "contractors", elec: "electrical",
  plbg: "plumbing", excav: "excavation", renov: "renovation", crk: "creek", st: "state", pt: "point", grp: "group",
  lndscp: "landscapes", co: "company" };
const NOISE = new Set(["llc", "inc", "co", "company", "dba", "the", "and", "group"]);

export function nameTokens(name: string): string[] {
  return name.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter(Boolean)
    .map(t => ABBREV[t] ?? t).filter(t => !NOISE.has(t));
}

export function matchCustomer(payerName: string, customers: Customer[]): { customer: Customer | null; score: number } {
  const p = new Set(nameTokens(payerName));
  let best: Customer | null = null, bestScore = 0, second = 0;
  for (const c of customers) {
    const ct = new Set(nameTokens(c.name));
    const inter = [...p].filter(t => ct.has(t)).length;
    const score = inter / Math.max(ct.size, 1);
    if (score > bestScore) { second = bestScore; bestScore = score; best = c; }
    else if (score > second) second = score;
  }
  // Need most of the customer's name, and a clear winner
  if (bestScore >= 0.6 && bestScore - second >= 0.3) return { customer: best, score: bestScore };
  return { customer: null, score: bestScore };
}

// ---------- subset sum over open invoices ----------
export function findSubsets(invoices: Invoice[], target: number, maxSize = 3, limit = 2): Invoice[][] {
  const out: Invoice[][] = [];
  const cents = Math.round(target * 100);
  const sorted = [...invoices].sort((a, b) => b.balance - a.balance);
  const walk = (start: number, chosen: Invoice[], sum: number) => {
    if (out.length >= limit) return;
    if (sum === cents && chosen.length) { out.push([...chosen]); return; }
    if (chosen.length === maxSize || sum > cents) return;
    for (let i = start; i < sorted.length; i++) {
      chosen.push(sorted[i]);
      walk(i + 1, chosen, sum + Math.round(sorted[i].balance * 100));
      chosen.pop();
    }
  };
  walk(0, [], 0);
  return out;
}

// ---------- the decision ----------
export function decide(payment: Payment, ex: Extraction, customers: Customer[], openInvoices: Invoice[]): Decision {
  const trace: string[] = [`extracted (${ex.source}): invoices [${ex.invoiceNumbers.join(", ")}], POs [${ex.poNumbers.join(", ")}], discount ${ex.discountPctClaimed ?? "none"}`];
  const review = (reason: string, rule: string, customerId: string | null, confidence: number, suggestion: Application[] = []): Decision =>
    ({ paymentId: payment.id, action: "review", customerId, applications: suggestion, confidence, rule, reason, trace });
  const apply = (rule: string, reason: string, customerId: string, confidence: number, applications: Application[]): Decision =>
    confidence >= AUTO_APPLY_THRESHOLD
      ? { paymentId: payment.id, action: "auto_apply", customerId, applications, confidence, rule, reason, trace }
      : review(`${reason} (confidence ${confidence.toFixed(2)} is below ${AUTO_APPLY_THRESHOLD})`, rule, customerId, confidence, applications);

  // 1. Invoice or PO references point to the customer directly, even if the payer name is unclear.
  const byId = new Map(openInvoices.map(i => [i.id, i]));
  // One PO can cover several invoices (split shipments), so a PO maps to a list.
  const byPo = new Map<string, Invoice[]>();
  for (const i of openInvoices) if (i.poNumber) byPo.set(i.poNumber, [...(byPo.get(i.poNumber) ?? []), i]);
  const refs = [...ex.invoiceNumbers.map(n => byId.get(n)), ...ex.poNumbers.flatMap(p => byPo.get(p) ?? [])].filter((i): i is Invoice => !!i);
  const refsUnique = [...new Map(refs.map(i => [i.id, i])).values()];
  const mentioned = ex.invoiceNumbers.length + ex.poNumbers.length;
  const found = ex.invoiceNumbers.filter(n => byId.has(n)).length + ex.poNumbers.filter(p => byPo.has(p)).length;

  const { customer: payerMatch, score } = matchCustomer(payment.payerName, customers);
  trace.push(`payer "${payment.payerName}" -> ${payerMatch ? `${payerMatch.id} ${payerMatch.name} (score ${score.toFixed(2)})` : `no confident match (best score ${score.toFixed(2)})`}`);

  if (refsUnique.length) {
    const custIds = new Set(refsUnique.map(i => i.customerId));
    if (custIds.size > 1) return review("References point to invoices from more than one customer.", "conflicting_references", null, 0.2);
    const customerId = refsUnique[0].customerId;
    if (payerMatch && payerMatch.id !== customerId) {
      return review(`Payer looks like ${payerMatch.name}, but the referenced invoices belong to ${customerId}. Possible third-party or joint check.`, "payer_mismatch", customerId, 0.4);
    }
    if (found < mentioned) {
      trace.push(`${mentioned - found} reference(s) not found among open invoices`);
      return review("Some referenced invoices are not open (already paid, wrong number, or another customer).", "reference_not_open", customerId, 0.4);
    }
    const open = round2(refsUnique.reduce((a, i) => a + i.balance, 0));
    trace.push(`referenced open balance ${money(open)}, paid ${money(payment.amount)}`);
    const nameBoost = payerMatch ? 0.02 : 0;

    if (same(payment.amount, open)) {
      return apply("exact_reference", `Paid the full open balance of ${refsUnique.length} referenced invoice(s).`, customerId, 0.97 + nameBoost,
        refsUnique.map(i => ({ invoiceId: i.id, amount: i.balance, discount: 0 })));
    }
    // Early-pay discount: allowed only if every invoice offers it and the payment arrived inside the window.
    const discounted = round2(refsUnique.reduce((a, i) => a + round2(i.balance * (1 - i.discountPct / 100)), 0));
    if (refsUnique.every(i => i.discountPct > 0) && same(payment.amount, discounted)) {
      const late = refsUnique.filter(i => daysBetween(i.invoiceDate, payment.receivedDate) > i.discountDays);
      if (late.length) {
        return review(`Discount taken after the ${late[0].discountDays}-day window (paid ${Math.round(daysBetween(late[0].invoiceDate, payment.receivedDate))} days after invoice). Approve or bill the difference.`,
          "late_discount", customerId, 0.5, refsUnique.map(i => ({ invoiceId: i.id, amount: round2(i.balance * (1 - i.discountPct / 100)), discount: 0 })));
      }
      return apply("early_pay_discount", "Paid within the discount window with the agreed early-pay discount.", customerId, 0.94 + nameBoost,
        refsUnique.map(i => ({ invoiceId: i.id, amount: round2(i.balance * (1 - i.discountPct / 100)), discount: round2(i.balance * i.discountPct / 100) })));
    }
    if (payment.amount < open) {
      return review(`Short pay: ${money(round2(open - payment.amount))} less than the referenced balance. Check for a dispute or deduction before applying.`, "short_pay", customerId, 0.3,
        refsUnique.length === 1 ? [{ invoiceId: refsUnique[0].id, amount: payment.amount, discount: 0 }] : []);
    }
    return review(`Overpayment: ${money(round2(payment.amount - open))} more than the referenced balance. Decide whether to hold as credit or refund.`, "overpayment", customerId, 0.3);
  }

  // 2. No usable references: rely on the payer and the amount.
  if (mentioned) trace.push("references in the text did not match any open invoice");
  if (!payerMatch) return review("Could not identify the customer from the payer name, and the remittance has no usable invoice or PO reference.", "unknown_payer", null, 0.1);
  const theirs = openInvoices.filter(i => i.customerId === payerMatch.id && i.balance > 0);
  const exact = theirs.filter(i => same(i.balance, payment.amount));
  trace.push(`${theirs.length} open invoices for ${payerMatch.id}; ${exact.length} with exactly this amount`);
  if (mentioned) return review("The remittance mentions references that don't match any open invoice.", "reference_not_open", payerMatch.id, 0.3, exact.length === 1 ? [{ invoiceId: exact[0].id, amount: exact[0].balance, discount: 0 }] : []);
  if (exact.length === 1) {
    return apply("unique_amount", `No reference given, but exactly one open invoice for this customer matches ${money(payment.amount)}.`, payerMatch.id, 0.9,
      [{ invoiceId: exact[0].id, amount: exact[0].balance, discount: 0 }]);
  }
  if (exact.length > 1) {
    return review(`${exact.length} open invoices match ${money(payment.amount)}. Ask the customer which one this pays.`, "ambiguous_amount", payerMatch.id, 0.3);
  }
  const subsets = findSubsets(theirs, payment.amount);
  trace.push(`${subsets.length} combination(s) of open invoices sum to the payment`);
  if (subsets.length === 1) {
    const set = subsets[0];
    return apply("invoice_combination", `No reference given, but exactly one combination of ${set.length} open invoices adds up to ${money(payment.amount)}.`,
      payerMatch.id, set.length === 2 ? 0.9 : 0.86, set.map(i => ({ invoiceId: i.id, amount: i.balance, discount: 0 })));
  }
  return review("No invoice or combination of invoices matches this amount. Hold as unapplied cash and contact the customer.", "no_match", payerMatch.id, 0.1);
}

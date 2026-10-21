import { describe, expect, it } from "vitest";
import { llmExtract, normalizeRef, offlineExtract } from "../src/extract";
import { AUTO_APPLY_THRESHOLD, decide, findSubsets, matchCustomer } from "../src/match";
import { evaluate, DEV_SEED, HOLDOUT_SEED } from "../src/evals";
import { generate } from "../src/data/generate";
import { stressSet } from "../src/data/stress";
import type { Customer, Extraction, Invoice, Payment } from "../src/types";

const customers: Customer[] = [{ id: "C1", name: "Ridgeline Builders LLC" }, { id: "C2", name: "Summit Concrete Inc" }];
const invoice = (id: string, amount: number, o: Partial<Invoice> = {}): Invoice =>
  ({ id, customerId: "C1", poNumber: null, invoiceDate: "2026-10-01", amount, balance: amount, discountPct: 0, discountDays: 10, ...o });
const payment = (amount: number, remittance: string, o: Partial<Payment> = {}): Payment =>
  ({ id: "P1", receivedDate: "2026-10-30", amount, method: "ach", payerName: "RIDGELINE BLDRS", remittance, ...o });
const run = (p: Payment, invs: Invoice[]) => decide(p, offlineExtract(p.remittance), customers, invs);

describe("offline extractor", () => {
  it("reads invoice numbers, POs and discounts", () => {
    const e = offlineExtract("Inv# 10234, 10236 less 2% disc PO 5512");
    expect(e.invoiceNumbers).toEqual(["10234", "10236"]);
    expect(e.poNumbers).toEqual(["PO-5512"]);
    expect(e.discountPctClaimed).toBe(2);
  });
  it("fixes O and l typos", () => {
    expect(normalizeRef("1O234")).toBe("10234");
    expect(offlineExtract("INV l0O23").invoiceNumbers).toEqual(["10023"]);
  });
  it("ignores short numbers like years and amounts", () => {
    expect(offlineExtract("Oct 2026 $1,234.56").invoiceNumbers).toEqual([]);
  });
});

describe("LLM extractor (fake client, no API call)", () => {
  it("reads the forced tool call and cleans the values", async () => {
    let request: any;
    const fake = { messages: { create: async (req: any) => { request = req; return {
      content: [{ type: "tool_use", id: "t1", name: "record_remittance",
                  input: { invoice_numbers: ["INV-1O234", "x"], po_numbers: ["5512"], discount_pct_claimed: 2 } }] }; } } };
    const e = await llmExtract(fake as any, "Inv 1O234 less 2% PO 5512");
    expect(request.tool_choice).toEqual({ type: "tool", name: "record_remittance" });
    expect(e).toEqual<Extraction>({ invoiceNumbers: ["10234"], poNumbers: ["PO-5512"], discountPctClaimed: 2, source: "llm" });
  });
  it("fails loudly if the model does not return structured output", async () => {
    const fake = { messages: { create: async () => ({ content: [{ type: "text", text: "sure!" }] }) } };
    await expect(llmExtract(fake as any, "x")).rejects.toThrow("structured");
  });
});

describe("customer matching", () => {
  it("handles bank abbreviations", () => {
    expect(matchCustomer("RIDGELINE BLDRS", customers).customer?.id).toBe("C1");
    expect(matchCustomer("Summit Concrete, Inc.", customers).customer?.id).toBe("C2");
  });
  it("refuses to guess an unknown payer", () => {
    expect(matchCustomer("FIRST REGIONAL BANK", customers).customer).toBeNull();
  });
});

describe("decisions", () => {
  it("auto-applies an exact reference", () => {
    const d = run(payment(500, "INV 10001"), [invoice("10001", 500)]);
    expect(d.action).toBe("auto_apply");
    expect(d.applications).toEqual([{ invoiceId: "10001", amount: 500, discount: 0 }]);
  });
  it("applies an early-pay discount inside the window, and writes the discount off", () => {
    const d = run(payment(980, "10001 less 2%", { receivedDate: "2026-10-05" }), [invoice("10001", 1000, { discountPct: 2 })]);
    expect(d.action).toBe("auto_apply");
    expect(d.applications[0]).toEqual({ invoiceId: "10001", amount: 980, discount: 20 });
  });
  it("sends a late discount to review", () => {
    const d = run(payment(980, "10001 less 2%", { receivedDate: "2026-10-25" }), [invoice("10001", 1000, { discountPct: 2 })]);
    expect([d.action, d.rule]).toEqual(["review", "late_discount"]);
  });
  it("sends short pays and overpayments to review", () => {
    expect(run(payment(400, "INV 10001"), [invoice("10001", 500)]).rule).toBe("short_pay");
    expect(run(payment(600, "INV 10001"), [invoice("10001", 500)]).rule).toBe("overpayment");
  });
  it("matches a unique amount with no reference, but not an ambiguous one", () => {
    expect(run(payment(712.4, ""), [invoice("10001", 712.4), invoice("10002", 90)]).action).toBe("auto_apply");
    expect(run(payment(712.4, ""), [invoice("10001", 712.4), invoice("10002", 712.4)]).rule).toBe("ambiguous_amount");
  });
  it("flags a payer paying someone else's invoice", () => {
    const d = run(payment(500, "INV 10001", { payerName: "SUMMIT CONCRETE" }), [invoice("10001", 500)]);
    expect(d.rule).toBe("payer_mismatch");
  });
  it("never auto-applies below the confidence threshold", () => {
    const invs = [invoice("10001", 100), invoice("10002", 200), invoice("10003", 300)];
    const d = run(payment(600, ""), invs);
    expect(d.confidence).toBeLessThan(AUTO_APPLY_THRESHOLD);
    expect(d.action).toBe("review");
    expect(d.applications).toHaveLength(3);       // the suggestion is still there for the reviewer
  });
  it("finds the invoice combination that adds up to a payment", () => {
    const s = findSubsets([invoice("1", 100), invoice("2", 250.5), invoice("3", 75)], 175);
    expect(s.map(x => x.map(i => i.id).sort())).toEqual([["1", "3"]]);
  });
});

describe("evals as a regression gate", () => {
  const offline = async (t: string) => offlineExtract(t);
  it("never applies cash wrongly on any eval set", async () => {
    for (const data of [generate(DEV_SEED, 160), generate(HOLDOUT_SEED, 90), stressSet()]) {
      const { result } = await evaluate(data, offline);
      expect(result.wrongAutoApplications).toBe(0);
      expect(result.correctEscalations).toBe(result.shouldReview);
    }
  });
  it("keeps straight-through processing above 75% on generated data", async () => {
    const { result } = await evaluate(generate(HOLDOUT_SEED, 90), offline);
    expect(result.straightThroughRate).toBeGreaterThan(0.75);
  });
});

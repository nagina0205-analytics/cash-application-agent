// Read invoice numbers, PO numbers and claimed discounts out of remittance text.
//
// Two extractors with the same output shape:
//   - llmExtract: Claude, forced to call a tool whose input schema is the
//     Extraction shape, so the reply is always structured JSON.
//   - offlineExtract: rules and regular expressions. Free, deterministic,
//     used in tests and as the fallback when no API key is set.
// The matcher never trusts either blindly: every invoice number is checked
// against the open invoices in the database before any cash moves.
import type Anthropic from "@anthropic-ai/sdk";
import type { Extraction } from "./types";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";

/** Fix the characters people mistype in invoice numbers: O for 0, l or I for 1. */
export function normalizeRef(token: string): string {
  // Drop a leading "INV", "Invoice #" etc. first, so its letters are never read as digits.
  const core = token.trim().replace(/^(inv(oice)?s?|no|num(ber)?)[\s.#:-]*/i, "").replace(/^#/, "");
  return core.replace(/[Oo]/g, "0").replace(/[lI]/g, "1").replace(/[^0-9]/g, "");
}

export function offlineExtract(text: string): Extraction {
  const t = text ?? "";
  const poNumbers = [...t.matchAll(/\bPO[-#:\s]*([0-9]{3,6})\b/gi)].map(m => `PO-${m[1]}`);
  const withoutPo = t.replace(/\bPO[-#:\s]*[0-9]{3,6}\b/gi, " ");
  // Invoice-like tokens: 5+ characters made of digits, allowing O/l/I typos.
  const invoiceNumbers = [...withoutPo.matchAll(/(?:inv(?:oice)?s?\s*#?\s*)?\b([0-9OolI]{5,8})\b/gi)]
    .map(m => m[1])
    .filter(tok => /[0-9]/.test(tok) && /^[0-9OolI]+$/.test(tok))
    .map(normalizeRef)
    .filter(n => n.length >= 5);
  const disc = t.match(/(\d+(?:\.\d+)?)\s*%\s*(?:disc|discount|early)/i) ?? t.match(/\b(\d)\/10\b/);
  return { invoiceNumbers: [...new Set(invoiceNumbers)], poNumbers: [...new Set(poNumbers)],
           discountPctClaimed: disc ? Number(disc[1]) : null, source: "offline" };
}

const TOOL = {
  name: "record_remittance",
  description: "Record what the remittance text says. Only include values that appear in the text.",
  input_schema: {
    type: "object" as const,
    properties: {
      invoice_numbers: { type: "array", items: { type: "string" }, description: "Invoice numbers as digits only. Fix obvious typos like O for 0." },
      po_numbers: { type: "array", items: { type: "string" }, description: "Purchase order numbers, formatted PO-<digits>." },
      discount_pct_claimed: { type: ["number", "null"], description: "Early-pay discount percent the payer says they took, or null." },
    },
    required: ["invoice_numbers", "po_numbers", "discount_pct_claimed"],
  },
};

export async function llmExtract(client: Pick<Anthropic, "messages">, text: string): Promise<Extraction> {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: `Remittance text from a customer payment:\n\n${text || "(empty)"}` }],
  });
  const block = msg.content.find(b => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("model did not return structured output");
  const input = block.input as { invoice_numbers?: unknown; po_numbers?: unknown; discount_pct_claimed?: unknown };
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    invoiceNumbers: [...new Set(strings(input.invoice_numbers).map(normalizeRef).filter(n => n.length >= 5))],
    poNumbers: [...new Set(strings(input.po_numbers).map(p => `PO-${p.replace(/[^0-9]/g, "")}`))],
    discountPctClaimed: typeof input.discount_pct_claimed === "number" ? input.discount_pct_claimed : null,
    source: "llm",
  };
}

// The cash application agent: extract, decide, record. One payment at a time.
import Anthropic from "@anthropic-ai/sdk";
import { llmExtract, offlineExtract } from "./extract";
import { decide } from "./match";
import type { Store } from "./store";
import type { Decision, Extraction, Payment } from "./types";

export type Extractor = (text: string) => Promise<Extraction>;

/** Claude when ANTHROPIC_API_KEY is set, otherwise the offline extractor. */
export function defaultExtractor(): Extractor {
  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic();
    return async (text) => {
      try {
        return await llmExtract(client, text);
      } catch {
        // If the model call fails, fall back rather than stall the payment queue.
        return offlineExtract(text);
      }
    };
  }
  return async (text) => offlineExtract(text);
}

export async function processPayment(store: Store, payment: Payment, extract: Extractor): Promise<Decision> {
  const started = performance.now();
  const extraction = await extract(payment.remittance);
  const decision = decide(payment, extraction, await store.customers(), await store.openInvoices());
  decision.trace.push(`decided ${decision.action} by rule ${decision.rule} in ${(performance.now() - started).toFixed(1)}ms`);
  await store.record(decision, payment.amount);
  return decision;
}

export async function processAll(store: Store, payments: Payment[], extract: Extractor): Promise<Decision[]> {
  const out: Decision[] = [];
  const ordered = [...payments].sort((a, b) => a.receivedDate.localeCompare(b.receivedDate) || a.id.localeCompare(b.id));
  for (const p of ordered) out.push(await processPayment(store, p, extract));
  return out;
}
